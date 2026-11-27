# Deploying

## Run the binary

Copy the `heybe` binary to the server and run it from a directory you own. `hb_data`, `hb_hooks` and `hb_migrations` are created or read next to the data directory, so use a fixed `--dir`:

```bash
/opt/heybe/heybe serve --dir /opt/heybe/hb_data --http 127.0.0.1:8090
```

### systemd

```ini
# /etc/systemd/system/heybe.service
[Unit]
Description=Heybe
After=network.target

[Service]
User=heybe
WorkingDirectory=/opt/heybe
ExecStart=/opt/heybe/heybe serve --dir /opt/heybe/hb_data --http 127.0.0.1:8090
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now heybe
```

Put a reverse proxy in front of it for HTTPS, or use the built-in Let's Encrypt support below.

## HTTPS with Let's Encrypt

Pass your domain to `serve`:

```bash
./heybe serve example.com
```

Ports 80 and 443 must be reachable from the internet. With a domain, Heybe listens on `0.0.0.0:80` and `0.0.0.0:443`, requests a certificate, and redirects HTTP to HTTPS. The certificate is cached in the data directory and checked for renewal every 12 hours. `--https` needs a domain: Let's Encrypt cannot issue a certificate for an IP address.

## Docker

Mount a volume on `/heybe/hb_data` and pin the image tag. See [Docker](/docker).

## Backups

Backups are zip files of the data directory. Create, download, upload, restore and delete them in the dashboard, or with `heybe.backups` in the [client](/client).

- Backups are stored in `hb_data/backups`, or on S3 when you enable it in the backup settings.
- Automatic backups use a cron expression in the backup settings (`cron`) and keep the newest `cronMaxKeep` (default 3). A failed automatic backup emails the superusers.
- A restore restarts the server. The Windows binary cannot restore in place: restore on Linux, macOS or in Docker.

Copy backups off the server. A backup on the same disk does not survive the disk.

## Settings worth checking

- `--origins`: the default `*` allows every CORS origin. Set your own origins in production.
- Superuser IPs: `heybe superuser ips <ip or cidr>...` limits superuser access to the listed addresses.
