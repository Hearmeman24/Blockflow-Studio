"""Backend for the Prompt Writer block: one small chat interface over
OpenRouter (hosted, BYOK), Ollama and LM Studio (local servers).

- ``transport``: an injectable HTTP transport (tests pass a fake).
- ``base_urls``: the local-server URL prefs and their validation.
- ``providers``: one adapter per provider (probe, list models, chat).
- ``service``: provider status, generation and the OpenRouter key check.
"""
