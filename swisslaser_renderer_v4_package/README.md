# SwissLaser Renderer v4

Deterministic 1080x1350 testimonial renderer for the approved clean-white single-frame SwissLaser layout.

## Deploy

```bash
unzip swisslaser_renderer_v4_clean_white.zip
cd swisslaser_renderer_v4_package
cp .env.example .env
# Set N8N_DOCKER_NETWORK in .env
docker compose down
docker compose up -d --build
```

## Test

```bash
curl http://localhost:8787/health
```

Expected version: `4.0.0`.
