# Third-party notices

This plugin is licensed under AGPL-3.0-only. The complete license is in `LICENSE`.

It builds upon `sogud/mygo-music-netease` (AGPL-3.0-only), whose NetEase API protocol and data mappings were adapted from:

- Repository: https://github.com/sogud/mygo-cloudmusic
- Original project: https://github.com/egoist/mygo-cloudmusic
- Upstream author: egoist and contributors; preserved fork: sogud.
- Reference commit: `b13f52a2a2ff0746502b85b9c4c7fa1e86a1c385`.
- Files consulted: `internal/netease/eapi.go`, `auth.go`, `netease.go`, `catalog.go`, `playlist.go`, `podcast.go`, `search_suggest.go`, `subscriptions.go`.
- Upstream license: GNU Affero General Public License version 3.

Host API reference: https://github.com/egoist/mygo-music (`internal/music/music.go`, `internal/plugin`), licensed under AGPL-3.0 and distributed separately.

Recommendation endpoint shapes and FM modes were checked against AkinoKaede/mygo-music-netease-cloud-music, commit `c988df7f4d787c1a133ba66e1f4f9dd71a2650cf` (`index.js`, AGPL-3.0).

Playlist track editing was adapted from jieye666's contribution in https://github.com/sogud/mygo-music-netease/pull/6, commit `29c6cffd6990d527a3d9e46757824dc0f6903881` (AGPL-3.0-only).

Additions in `mygo-music-netease-plus`:
- Paired `EAPI_CLIENT` / `EAPI_UA` desktop fingerprint to resolve `-460` playback rejections.
- User profile pages (`Account.page`, `user:<uid>`), following/followers lists, per-user created/saved playlists, per-user listening records, podcast publisher links (`Show.publisherPage`), search suggestions (`suggest`), saved albums (`savedAlbums`, `saveAlbum`), artist/playlist/podcast subscription controls, and playlist CRUD actions.

NetEase Cloud Music names and content belong to their respective owners. This project is not an official NetEase or MyGo Music release.
