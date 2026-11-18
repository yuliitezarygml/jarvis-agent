"""Download the pinned Russian checkpoint once and write an offline config."""
import os
from pathlib import Path
from huggingface_hub import hf_hub_download
import yaml

REPO = 'ArtShtorm/Shtorm-PocketTTS-RU'
REVISION = '33f6c328d62c4da5c1227bbe081e89b574a6183a'


def prepare():
    root = Path(os.environ.get('JARVIS_TTS_HOME', '/opt/jarvis-tts'))
    source = hf_hub_download(REPO, 'config_fast.yaml', revision=REVISION)
    config = yaml.safe_load(Path(source).read_text(encoding='utf8'))

    def local(value):
        if isinstance(value, dict):
            return {key: local(item) for key, item in value.items()}
        if isinstance(value, list):
            return [local(item) for item in value]
        if isinstance(value, str) and value.startswith('hf://'):
            prefix = f'hf://{REPO}/'
            if not value.startswith(prefix):
                raise RuntimeError('Unexpected external checkpoint dependency')
            filename = value[len(prefix):].split('@', 1)[0]
            return hf_hub_download(REPO, filename, revision=REVISION)
        return value

    destination = root / 'cache/model-config.yaml'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(yaml.safe_dump(local(config), allow_unicode=True), encoding='utf8')
    print(f'Offline voice config ready: {destination}')


if __name__ == '__main__':
    prepare()
