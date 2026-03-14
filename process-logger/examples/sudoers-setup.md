# Sudoers setup for time and system actions

This setup is required so these API endpoints work without password prompts:
- `POST /api/ntp`
- `POST /api/time/manual`
- `POST /api/time/timezone`
- `POST /api/system/restart-logger`
- `POST /api/system/reboot`

## 1) Determine service user
Find the Linux user running the process-logger service:

```bash
systemctl show -p User process-logger.service
```

If empty, the service runs as `root` and no sudoers entry is needed for these commands.

## 2) Install sudoers file
Copy the template and replace `processlogger` with your real service user:

```bash
sudo cp process-logger/examples/sudoers-process-logger.conf /etc/sudoers.d/process-logger
sudo nano /etc/sudoers.d/process-logger
```

Validate and fix permissions:

```bash
sudo visudo -cf /etc/sudoers.d/process-logger
sudo chmod 0440 /etc/sudoers.d/process-logger
```

## 3) Restart backend service

```bash
sudo systemctl restart process-logger.service
```

## 4) Verify non-interactive sudo
Run as service user (replace `<service-user>`):

```bash
sudo -u <service-user> sudo -n /usr/bin/chronyc online
sudo -u <service-user> sudo -n /usr/bin/chronyc -a makestep
sudo -u <service-user> sudo -n /bin/date -s "2026-03-11 15:40:00"
sudo -u <service-user> sudo -n /usr/bin/timedatectl set-timezone Europe/Berlin
sudo -u <service-user> sudo -n /bin/systemctl restart process-logger.service
```

Each command should return without a password prompt.
