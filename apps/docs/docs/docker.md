# Docker

```bash
docker run -d -p 8090:8090 -v hb_data:/heybe/hb_data ghcr.io/emresandikci/heybe
```

Images are published for `linux/amd64` and `linux/arm64` and tagged `latest`, `x`, `x.y` and `x.y.z`. Pin an exact `x.y.z` tag in production.

## Paths

| Path                   | Contents                       |
| ---------------------- | ------------------------------ |
| `/heybe/hb_data`       | Database, uploaded files, logs |
| `/heybe/hb_migrations` | Your migrations                |
| `/heybe/hb_hooks`      | Your hooks and routes          |

Mount a volume on `hb_data`, or the database is lost when the container is removed. Mount `hb_hooks` and `hb_migrations` from your project to load your own code:

```bash
docker run -d -p 8090:8090 \
  -v hb_data:/heybe/hb_data \
  -v ./hb_hooks:/heybe/hb_hooks \
  -v ./hb_migrations:/heybe/hb_migrations \
  ghcr.io/emresandikci/heybe
```

## Create a superuser

```bash
docker exec <container> heybe superuser upsert <email> <password> --dir /heybe/hb_data
```

## Windows

There is no Windows container image. Windows hosts can run the Linux image with Docker Desktop (WSL2).
