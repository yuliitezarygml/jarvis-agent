import concurrent.futures
import threading
import time
import unittest
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi.testclient import TestClient
from server import Engine, SpeechRequest, acute_stress, create_app, normalize_anglicisms


class FakeEngine:
    ready = True

    def __init__(self):
        self.calls = 0
        self.active = 0
        self.maximum = 0
        self.fail = False
        self.lock = threading.Lock()

    def synth(self, body, stop):
        with self.lock:
            self.calls += 1
            self.active += 1
            self.maximum = max(self.active, self.maximum)
        try:
            time.sleep(0.03)
            if self.fail:
                self.fail = False
                raise RuntimeError('test engine failure')
            return b'RIFF' + bytes(64), False
        finally:
            with self.lock:
                self.active -= 1


class VoiceApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.client = TestClient(create_app(self.engine, load=False))

    def tearDown(self):
        self.client.close()

    def test_russian_stress_is_converted_without_losing_letters_or_punctuation(self):
        self.assertEqual(acute_stress('С+эр, +я гот+ов. Ёлка и ещ+ё!'), 'Сэ́р, я́ гото́в. Ёлка и ещё́!')

    def test_english_words_inside_russian_work_with_or_without_token_type_ids(self):
        for with_types in (False, True):
            with self.subTest(token_type_ids=with_types):
                generated = []
                class Tensor:
                    def to(self, device): return self
                    def tolist(self): return [1, 2]
                class Tokenizer:
                    def __call__(self, text, **kwargs):
                        self_test.assertEqual(text, '<pad><pad><pad>Jarvis')
                        fields = {'input_ids': Tensor(), 'attention_mask': Tensor()}
                        if with_types: fields['token_type_ids'] = Tensor()
                        return fields
                    def decode(self, ids): return '<pad><s>джарвис</s>'
                def generate(**kwargs):
                    generated.append(kwargs)
                    return [Tensor()]
                self_test = self
                normalizer = SimpleNamespace(angl_tokenizer=Tokenizer(), angl_model=SimpleNamespace(device='cpu', generate=generate), kirillizator=lambda text: text)
                self.assertEqual(normalize_anglicisms(normalizer, 'Jarvis'), 'джарвис')
                self.assertNotIn('token_type_ids', generated[0])
                self.assertIn('attention_mask', generated[0])

    def test_rejects_unsupported_or_invalid_input_without_running_model(self):
        requests = [
            {'text': ''}, {'text': ' '}, {'text': 'т' * 2001},
            {'text': 'Hello', 'lang': 'en'}, {'text': '... 🎵', 'lang': 'ru'},
            {'text': 'Привет', 'format': 'exe'}, {'text': 'Привет', 'speed': 0},
            {'text': 'Привет', 'speed': 'NaN'}, {'text': 'Привет', 'voice_path': '/etc/passwd'},
        ]
        for payload in requests:
            with self.subTest(payload=str(payload)[:60]):
                self.assertEqual(self.client.post('/api/tts', json=payload).status_code, 422)
        self.assertEqual(self.engine.calls, 0)

    def test_russian_voice_accepts_numbers_and_latin_names_without_cyrillic_padding(self):
        for text in ['25', '3.14', 'CPU', 'Windows', 'Jarvis', 'OK', 'Good morning, sir.']:
            with self.subTest(text=text):
                response = self.client.post('/api/tts', json={'text': text, 'lang': 'ru'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content[:4], b'RIFF')
        self.assertEqual(self.engine.calls, 7)

    def test_not_ready_never_claims_health_or_runs_inference(self):
        self.engine.ready = False
        self.assertFalse(self.client.get('/api/health').json()['ok'])
        self.assertEqual(self.client.post('/api/tts', json={'text': 'Привет'}).status_code, 503)
        self.assertEqual(self.engine.calls, 0)

    def test_concurrent_http_requests_do_not_run_the_model_in_parallel(self):
        with self.client, concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(self.client.post, '/api/tts', json={'text': f'Проверка {i}'}) for i in range(3)]
            replies = [future.result(timeout=5) for future in futures]
        self.assertEqual([reply.status_code for reply in replies], [200, 200, 200])
        self.assertEqual(self.engine.maximum, 1)
        self.assertTrue(all(reply.headers['content-type'] == 'audio/wav' for reply in replies))
        self.assertTrue(all(reply.headers['cache-control'] == 'no-store' for reply in replies))

    def test_failed_synthesis_releases_queue_for_next_request(self):
        self.engine.fail = True
        with self.assertLogs('jarvis-tts', level='ERROR'):
            self.assertEqual(self.client.post('/api/tts', json={'text': 'Проверка'}).status_code, 500)
        self.assertEqual(self.client.post('/api/tts', json={'text': 'Повторная проверка'}).status_code, 200)

    def test_cancelled_stream_finishes_decoder_before_releasing_model_lock(self):
        import numpy as np
        engine = Engine()
        engine.accent = lambda text: text
        engine.normalizer = SimpleNamespace(norm=lambda text: text)
        engine.voice = {}
        stop = threading.Event()
        joined = []

        class Chunk:
            def detach(self): return self
            def cpu(self): return self
            def numpy(self): return np.zeros(2400, dtype='float32')

        class Model:
            sample_rate = 24000
            def generate_audio_stream(self, *args, **kwargs):
                yield Chunk()
                stop.set()
                yield Chunk()
                self_test.assertTrue(engine.lock.locked())
                joined.append(True)

        self_test = self
        engine.model = Model()
        with self.assertRaises(HTTPException) as error:
            engine.synth(SpeechRequest(text='Проверка'), stop)
        self.assertEqual(error.exception.status_code, 499)
        self.assertEqual(joined, [True])
        self.assertFalse(engine.lock.locked())
        self.assertEqual(engine.cache, {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
