# Cyclone Raspberry Pi Deployment

## 1) Clone and install

```bash
git clone <your-fork-or-repo-url> cyclone
cd cyclone
npm i
```

## 2) Build

```bash
npm run build
```

## 3) Run manually for first test

```bash
CYCLONE_HOST=0.0.0.0 CYCLONE_PORT=8080 npm run start:server
```

Open from another LAN machine:

`http://<pi-ip>:8080`

## 4) Install systemd service

Copy unit file and enable:

```bash
sudo cp ./docs/cyclone.service /etc/systemd/system/cyclone.service
sudo systemctl daemon-reload
sudo systemctl enable cyclone
sudo systemctl start cyclone
```

Check logs:

```bash
sudo systemctl status cyclone
journalctl -u cyclone -f
```

## 5) Firewall

Allow TCP 8080 on local network only.

