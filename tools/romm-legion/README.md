# tools/romm-legion — RomM on the Legion Go (Bazzite) with Podman

One script, run as your own user on the handheld:

```
bash tools/romm-legion/setup-romm.sh
```

or, from any machine that reaches the Legion over the tailnet:

```
ssh daniel@bazzite 'bash -s' < tools/romm-legion/setup-romm.sh
```

It writes three
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units under `~/.config/containers/systemd/` — a private network, MariaDB, and
RomM itself — generates the secrets into `~/.config/romm/romm.env`, drops a
`config.yml` that maps EmuDeck's folder names onto RomM's platform slugs,
enables linger so the services outlive the login session, and starts them. No
`podman-compose`, no layered packages, nothing outside `$HOME` unless
`--open-firewall` is passed (which asks sudo to open the port to the LAN).

| What                      | Where                                                       |
| ------------------------- | ----------------------------------------------------------- |
| the library RomM scans    | `~/Emulation/roms/<platform>/`                              |
| firmware                  | `~/Emulation/bios/`                                         |
| saves / states RomM holds | `~/Emulation/romm-assets/`                                  |
| secrets                   | `~/.config/romm/romm.env`                                   |
| RomM's config             | `~/.config/romm/config.yml`                                 |
| database, covers, redis   | podman volumes `romm-mysql`, `romm-resources`, `romm-redis` |
| the web UI                | `http://<legion>:8080/`                                     |

`ROMM_LIBRARY=/run/media/.../Emulation` points it at a tree on the SD card;
`ROMM_PORT` moves the port. Re-running is safe: existing secrets and config are
kept, the units are rewritten, the services restarted by `daemon-reload`.

The first visit runs RomM's setup wizard (admin user), then **Scan**. Metadata
providers (IGDB, ScreenScraper, RetroAchievements, SteamGridDB) are optional;
their keys go in `romm.env`, then `systemctl --user restart romm`.

Useful afterwards:

```
systemctl --user status romm romm-db
journalctl --user -u romm -f
podman auto-update
```
