#!/bin/bash
set -e

python3 -m venv .venv

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
    .venv/bin/pip install torch==2.5.1 torchvision==0.20.1
else
    .venv/bin/pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu118
fi

.venv/bin/pip install -r requirements.txt
openssl req -x509 -newkey rsa:4096 -nodes -out cert.pem -keyout key.pem -days 365