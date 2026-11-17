# 网易云音乐 Plus · MyGo Music 插件

在 [MyGo Music](https://github.com/egoist/mygo-music) 中使用的增强版网易云音乐插件（独立插件 ID：`netease-plus`），需要 MyGo Music `0.1.23` 或更新版本，无需额外后台服务。

## 安装

- **从 GitHub 安装**：打开 MyGo Music → 设置 → 插件 → `+` → 从 GitHub 安装，填入 `lng205/mygo-music-netease-plus`（或 `https://github.com/lng205/mygo-music-netease-plus`），也可直接打开安装链接：
  `mygo-music://install-plugin?repo=lng205/mygo-music-netease-plus`
- **从本地安装**：选择本项目文件夹，或执行 `npm run pack` 后选择 `dist/netease-plus-*.zip`。

## 新增与增强功能

- **修复 `-460` 拒绝播放**：将 EAPI HTTP `User-Agent` 与桌面端 `EAPI_CLIENT` 加密载荷统一配对，解决原版 iOS UA 与 PC 载荷冲突导致的风控拦截。
- **用户主页与关注体系**：
  - 点击顶部账号菜单 **我的主页** 直达个人主页（包含创建的歌单、收藏的歌单、音乐云盘、听歌排行、关注/粉丝与关注歌手入口）。
  - 侧栏新增 **我的关注**（支持分页查看关注的用户及粉丝列表），点击任意用户可打开其 **用户主页**，浏览对方创建和收藏的歌单、对方关注的人及公开的听歌排行。
  - 播客详情页支持点击发布者名称跳转至该发布者的用户主页。
- **搜索与收藏管理**：
  - 支持搜索框实时关键词联想（`suggest`）。
  - 支持 **收藏的专辑** 列表与收藏/取消收藏专辑、关注/取消关注歌手、收藏/取消收藏歌单、订阅/取消订阅播客。
  - 支持新建歌单、重命名歌单、删除歌单，以及歌单歌曲增删。
- **保留原有完整功能**：歌曲/专辑/歌手/歌单/播客搜索、每日推荐/私人雷达/私人漫游、逐字歌词与翻译、标准/高音质/无损音质播放、音乐云盘、听歌排行、只读热评与评论分页。

## 已知宿主边界

受限于当前 MyGo Music 宿主插件接口：
- `search` 仅支持 `tracks` / `albums` / `artists` / `playlists` / `shows` 五类，暂不支持在搜索框直接搜索用户。
- `Playlist` 与 `Comment` 数据结构暂不支持附带作者主页跳转链接，因此目前通过「我的主页 / 我的关注 / 播客发布者」链路进入用户主页。

## 开发与校验

无需构建或安装第三方依赖，Node 与 Python 仅用于本地校验和打包：

```sh
npm run check
npm test
npm run pack
```

[AGPL-3.0](LICENSE)
