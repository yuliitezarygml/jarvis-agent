"""Russian voice cloning on CPU. No Fish credentials or requests are used here."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager
import io
import logging
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import wave

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger('jarvis-tts')
ROOT = Path(os.environ.get('JARVIS_TTS_HOME', '/opt/jarvis-tts'))
MODEL_CONFIG = str(ROOT / 'cache/model-config.yaml')


def acute_stress(text: str) -> str:
    # Silero uses a plus before the vowel; this model was trained with an acute
    # after it. Passing the old model's notation changes pronunciation and tokens.
    return re.sub(r'\+([а-яё])', lambda match: match.group(1) + '\u0301', text, flags=re.I)


def normalize_anglicisms(normalizer, prompt: str) -> str:
    # RUNorm assumes every tokenizer returns token_type_ids. T5 tokenizers omit
    # that optional field; keep the original transliteration with safe removal.
    data = normalizer.angl_tokenizer('<pad><pad><pad>' + prompt, return_tensors='pt')
    data.pop('token_type_ids', None)
    data = {key: value.to(normalizer.angl_model.device) for key, value in data.items()}
    output = normalizer.angl_model.generate(
        **data, do_sample=False, max_new_tokens=128, repetition_penalty=1.0
    )[0]
    text = normalizer.angl_tokenizer.decode(output.tolist())
    text = text.replace('<s>', '').replace('</s>', '').replace('<pad>', '').strip()
    return normalizer.kirillizator(text)


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=2000)
    lang: str = 'ru'
    format: str = 'wav'
    speed: float = Field(default=1.0, ge=0.6, le=1.6, allow_inf_nan=False)


class Engine:
    def __init__(self):
        self.ready = False
        self.lock = threading.Lock()
        self.cache: OrderedDict[tuple[str, str, float], bytes] = OrderedDict()

    def load(self):
        import torch
        from pocket_tts import TTSModel
        from runorm import RUNorm
        from silero_stress import load_accentor
        import imageio_ffmpeg

        # Pocket TTS sets its own default at import; set our budget afterwards.
        torch.set_num_threads(int(os.environ.get('JARVIS_TTS_THREADS', '4')))
        self.torch = torch
        self.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        self.model = TTSModel.load_model(config=MODEL_CONFIG)
        self.voice = self.model.get_state_for_audio_prompt(str(ROOT / 'refs/jarvis-ru.wav'))
        self.accent = load_accentor()
        self.normalizer = RUNorm()
        self.normalizer.load(model_size='small', device='cpu', workdir=str(ROOT / 'cache/runorm'))
        self.normalizer.predict_anglicizms = normalize_anglicisms.__get__(self.normalizer)
        self.ready = True

    def synth(self, req: SpeechRequest, stop: threading.Event) -> tuple[bytes, bool]:
        if not self.lock.acquire(blocking=False):
            raise HTTPException(503, 'Speech engine is busy')
        try:
            key = (req.text, req.format, req.speed)
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key], True
            import numpy as np

            prepared = acute_stress(self.accent(self.normalizer.norm(req.text)))
            if stop.is_set():
                raise HTTPException(499, 'Request cancelled')
            chunks = []
            size = 0
            rate = self.model.sample_rate
            # The library splits long text by tokens. Accented Russian requires
            # shorter chunks than English; never truncate a string by characters.
            limit_hit = False
            for chunk in self.model.generate_audio_stream(self.voice, prepared, max_tokens=50, stop=stop):
                if stop.is_set():
                    # Drain the cancelled iterator so its decoder thread joins
                    # before the model lock is released for another request.
                    continue
                data = chunk.detach().cpu().numpy()
                chunks.append(data)
                size += data.size
                if size > rate * 90:
                    limit_hit = True
                    stop.set()
            if limit_hit:
                raise HTTPException(422, 'Speech exceeds the 90-second request limit')
            if stop.is_set():
                raise HTTPException(499, 'Request cancelled')
            if not chunks:
                raise RuntimeError('Speech engine produced no audio')
            audio = np.concatenate(chunks)
            if not np.isfinite(audio).all() or audio.size < rate // 10:
                raise RuntimeError('Speech engine produced invalid audio')
            pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype('<i2').tobytes()
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(pcm)
            result = output.getvalue()
            if req.format == 'mp3' or req.speed != 1.0:
                args = [self.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn']
                if req.speed != 1.0:
                    args += ['-af', f'atempo={req.speed}']
                args += ['-ar', str(rate), '-ac', '1']
                args += ['-f', 'mp3', '-codec:a', 'libmp3lame', '-b:a', '96k'] if req.format == 'mp3' else ['-f', 'wav', '-codec:a', 'pcm_s16le']
                converted = subprocess.run(args + ['pipe:1'], input=result, capture_output=True, timeout=15, check=True)
                result = converted.stdout
            self.cache[key] = result
            while len(self.cache) > 32:
                self.cache.popitem(last=False)
            return result, False
        finally:
            self.lock.release()


def create_app(engine=None, *, load=True) -> FastAPI:
    engine = engine if engine is not None else Engine()
    slot = asyncio.Semaphore(1)

    @asynccontextmanager
    async def lifespan(app):
        if load:
            await asyncio.to_thread(engine.load)
        yield

    app = FastAPI(title='Jarvis Russian Voice', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({'error': error.detail}, status_code=error.status_code)

    @app.get('/api/health')
    async def health():
        return {'ok': engine.ready, 'engine': 'pocket-tts-ru', 'model': 'Shtorm-PocketTTS-RU fast', 'voice': 'Jarvis RU clone', 'languages': ['ru'], 'external_tts': False, 'notice': ''}

    @app.post('/api/tts')
    async def tts(body: SpeechRequest, request: Request):
        if not engine.ready:
            raise HTTPException(503, 'Voice is starting')
        if body.lang != 'ru':
            raise HTTPException(422, 'This server supports Russian only')
        if body.format not in ('wav', 'mp3'):
            raise HTTPException(422, 'Supported audio formats: wav, mp3')
        # Russian utterances may contain a number or a Latin product name as a
        # separate sentence. RUNorm reads these using the same Russian voice.
        if not re.search('[а-яёa-z0-9]', body.text, re.I):
            raise HTTPException(422, 'Текст для озвучки не содержит слов или чисел')
        try:
            await asyncio.wait_for(slot.acquire(), timeout=10)
        except TimeoutError:
            raise HTTPException(503, 'Voice queue is full')
        stop = threading.Event()
        task = None
        start = time.perf_counter()
        try:
            task = asyncio.create_task(asyncio.to_thread(engine.synth, body, stop))
            while not task.done():
                if await request.is_disconnected():
                    stop.set()
                await asyncio.sleep(0.05)
            data, cached = await task
            ms = round((time.perf_counter() - start) * 1000)
            # No user text, reference audio or credentials in request logs.
            log.info('speech chars=%s ms=%s cached=%s', len(body.text), ms, cached)
            return Response(data, media_type='audio/wav' if body.format == 'wav' else 'audio/mpeg', headers={'Cache-Control': 'no-store', 'X-Synthesis-Ms': str(ms), 'X-Voice-Cache': 'hit' if cached else 'miss'})
        except asyncio.CancelledError:
            stop.set()
            if task is not None:
                try:
                    await asyncio.shield(task)
                except (Exception, asyncio.CancelledError):
                    pass
            raise
        except HTTPException:
            raise
        except Exception:
            log.exception('speech failed')
            raise HTTPException(500, 'Speech synthesis failed')
        finally:
            slot.release()

    return app


app = create_app()
