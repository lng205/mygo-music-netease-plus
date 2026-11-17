// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from sogud/mygo-music-netease and sogud/mygo-cloudmusic (originally egoist/mygo-cloudmusic).
// See THIRD_PARTY_NOTICES.md for the source revision and scope of the port.
// MyGo Music supplies host and fetch; this module has no Node dependencies.

const SITE = "https://music.163.com";
const EAPI = "https://interfacepc.music.163.com";
// Protocol key shared by the upstream client, not a user's credential.
const EAPI_KEY = "e82ckenh8dichen8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
// Keep the HTTP User-Agent paired with the Windows desktop EAPI header and
// interfacepc host to avoid NetEase -460 risk-control rejections on playback.
const EAPI_CLIENT = {
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  os: "pc",
  appver: "3.1.17.204416",
  versioncode: "140",
  resolution: "1920x1080",
  channel: "netease",
};
const EAPI_UA = `Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/${EAPI_CLIENT.appver}`;
const PAGE_SIZE = 30;
const PLAYLIST_LIMIT = 1000;
const PRIVATE_RADAR = "3136952023";
const COOKIE_NAMES = ["MUSIC_U", "__csrf", "NMTID"];

// MyGo 0.1.6 loads a module while holding the storage mutex. Host calls must
// happen inside an exported action, never during module initialization.
let session = null;
let epoch = 0;
let profileCheckedAt = 0;
let likedCache = null;
let likedRevision = 0;
const pendingStreams = new Map();
let discoveryCovers = null;
let heartState = null;
let pendingHeart = null;
let commentSnapshot = null;

function currentSession() {
  if (!session) session = host.storage.get("session") || { cookies: {}, profile: null };
  return session;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function idOf(value) {
  const id = String(value);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("无效的网易云音乐 ID");
  }
  return id;
}

function pageOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function secureURL(value) {
  return typeof value === "string" ? value.replace(/^http:\/\//, "https://") : "";
}

// MyGo Music 0.1.20+ replaces {size} (including URL-encoded braces) with the
// pixels needed by each view. Ask NetEase's image CDN to resize before the
// download, instead of fetching and decoding an original for a small row.
function artworkURL(value) {
  const picture = secureURL(value);
  if (!picture) return "";
  try {
    const url = new URL(picture);
    if (url.protocol !== "https:" || !/^p\d+\.music\.126\.net$/.test(url.hostname) ||
        url.port || url.username || url.password) return picture;
    // Set just the resize parameter, preserving other query values and the
    // fragment. Audio and external image services keep their original URLs.
    url.searchParams.set("param", "{size}y{size}");
    return url.toString();
  } catch {
    return picture;
  }
}

function deviceID() {
  let id = host.storage.get("deviceId");
  if (!id) {
    // This is an install identifier, never a credential or encryption key.
    id = Array.from({ length: 52 }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();
    host.storage.set("deviceId", id);
  }
  return id;
}

function cookieHeader(cookies) {
  return COOKIE_NAMES.filter((key) => cookies[key]).map((key) => `${key}=${cookies[key]}`).join("; ");
}

function acceptCookies(response, cookies) {
  // moejs supplies getSetCookie(): do not split a combined header on commas,
  // because an Expires attribute itself contains a comma.
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 1 || !COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(separator + 1);
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(line);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(line);
    const expired = maxAge ? Number(maxAge[1]) <= 0 : expires && Date.parse(expires[1]) <= Date.now();
    if (!value || expired) delete cookies[name];
    else cookies[name] = value;
  }
}

function persistSession() {
  if (session.cookies.MUSIC_U) host.storage.set("session", session);
  else host.storage.remove("session");
}

function clearSession() {
  epoch++;
  session = { cookies: {}, profile: null };
  profileCheckedAt = 0;
  likedCache = null;
  pendingStreams.clear();
  heartState = null;
  pendingHeart = null;
  host.storage.remove("session");
}

function acceptResponseCookies(response, activeSession) {
  const wasSignedIn = !!activeSession.cookies.MUSIC_U;
  acceptCookies(response, activeSession.cookies);
  if (activeSession === session) {
    if (wasSignedIn && !activeSession.cookies.MUSIC_U) {
      clearSession();
      throw fail("signIn", "网易云登录状态已失效，请重新登录");
    }
    persistSession();
  }
}

async function request(path, params = {}, options = {}) {
  const activeSession = options.session || currentSession();
  const startedEpoch = epoch;
  let url;
  const headers = { "User-Agent": UA, Referer: `${SITE}/` };
  const init = { headers, redirect: "error" };
  if (options.eapi) {
    const now = Date.now();
    const header = {
      ...EAPI_CLIENT,
      deviceId: deviceID(),
      mobilename: "",
      buildver: String(Math.floor(now / 1000)),
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      __csrf: "",
      ...activeSession.cookies,
    };
    const text = JSON.stringify({ ...params, header, e_r: false });
    const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
    const encrypted = host.crypto.aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`);
    url = EAPI + path.replace(/^\/api\//, "/eapi/");
    init.method = "POST";
    init.body = `params=${encrypted.toUpperCase()}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["User-Agent"] = EAPI_UA;
    headers.Cookie = Object.keys(header).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(header[key])}`).join("; ");
  } else {
    url = SITE + path;
    if (options.form !== undefined) {
      init.method = "POST";
      init.body = options.form;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      const query = new URLSearchParams(params).toString();
      if (query) url += `?${query}`;
    }
    const cookie = cookieHeader(activeSession.cookies);
    if (cookie) headers.Cookie = cookie;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  init.signal = controller.signal;
  let response, body;
  try {
    response = await fetch(url, init);
    if (!response.ok) throw new Error(`网易云请求失败（HTTP ${response.status}）`);
    body = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("网易云请求超时，请稍后重试");
    // Never put response bodies, request headers or login cookies in errors.
    if (response && !response.ok) throw error;
    if (response) throw new Error("网易云返回的响应无法解析，请稍后重试");
    throw new Error("无法读取网易云音乐，请检查网络及系统代理后重试");
  } finally {
    clearTimeout(timer);
  }
  if (startedEpoch !== epoch) throw new Error("账号状态已改变，请重试");
  if (!body || typeof body !== "object") throw new Error("网易云返回了无效数据");
  const code = Number(body.code);
  const allowed = options.codes || [200];
  if (!allowed.includes(code)) {
    // Content access can be forbidden while the account is still signed in.
    if (code === 401 && options.keepSession) {
      acceptResponseCookies(response, activeSession);
      throw fail("unavailable", "当前账号无权访问该内容");
    }
    if ([301, 302, 401].includes(code)) {
      if (activeSession === session) clearSession();
      throw fail("signIn", "请重新登录网易云音乐");
    }
    if (code === 460 || code === -460) {
      // A refused response can still renew NMTID. Keep the server's cookie
      // update for the same device/account retry, including session expiry.
      acceptResponseCookies(response, activeSession);
      const error = new Error(`网易云暂时拒绝了请求（${code}），请稍后重试`);
      error.neteaseCode = code;
      throw error;
    }
    if (code === 405) throw new Error("网易云暂时限制了请求，请稍后再试");
    throw new Error(`网易云接口返回错误（${Number.isFinite(code) ? code : "未知"}）`);
  }
  acceptResponseCookies(response, activeSession);
  return body;
}

const eapi = (path, params, options = {}) => request(path, params, { ...options, eapi: true });

function toArtist(artist = {}) {
  const item = { id: String(artist.id || ""), name: artist.name || "", imageUrl: artworkURL(artist.img1v1Url || artist.picUrl) };
  if (typeof artist.followed === "boolean") item.following = artist.followed;
  return item;
}

function toAlbum(album = {}) {
  const date = Number(album.publishTime);
  return {
    id: String(album.id || ""), name: album.name || "", imageUrl: artworkURL(album.picUrl),
    artists: (album.artists || (album.artist ? [album.artist] : [])).map(toArtist),
    released: date > 0 ? new Date(date).toISOString().slice(0, 10) : "",
  };
}

function toTrack(track) {
  const privilege = track.privilege;
  return {
    id: String(track.id), name: track.name || "",
    artists: (track.ar || track.artists || []).map(toArtist),
    album: toAlbum(track.al || track.album), duration: track.dt || track.duration || 0,
    url: `${SITE}/song?id=${track.id}`,
    unavailable: privilege ? privilege.st < 0 || privilege.pl <= 0 : track.fee === 1 || track.fee === 4,
  };
}

function toPlaylist(playlist) {
  return {
    id: String(playlist.id), name: playlist.name || "",
    imageUrl: artworkURL(playlist.coverImgUrl || playlist.picUrl),
    description: playlist.description || "", owner: playlist.creator?.nickname || "",
    trackCount: playlist.trackCount || 0, saved: !!playlist.subscribed,
    fixed: Number(playlist.specialType) === 5,
    mine: !!session?.profile && String(playlist.creator?.userId) === session.profile.id,
  };
}

function publisherPageFor(dj) {
  const uid = dj?.userId;
  return Number.isSafeInteger(Number(uid)) && Number(uid) > 0 ? `user:${uid}` : undefined;
}

function toShow(show) {
  const result = {
    id: String(show.id), name: show.name || "", imageUrl: artworkURL(show.picUrl),
    description: show.desc || "", publisher: show.dj?.nickname || "",
    episodeCount: show.programCount || 0, subscribed: !!show.subed,
  };
  const publisherPage = publisherPageFor(show.dj);
  if (publisherPage) result.publisherPage = publisherPage;
  return result;
}

function toEpisode(program, show) {
  const programID = idOf(program.id);
  const audioID = program.mainSong?.id ? idOf(program.mainSong.id) : null;
  const published = new Date(Number(program.createTime));
  return {
    // Keep the program ID for comments and the audio ID for playback. Missing
    // audio stays visible so the host's next offset still counts this episode.
    id: `program:${programID}${audioID ? ":" + audioID : ""}`,
    name: program.name || "", showId: String(show.id),
    artists: show.dj?.nickname ? [{ id: "", name: show.dj.nickname }] : [],
    album: { id: "", name: show.name || "", imageUrl: artworkURL(program.coverUrl || show.picUrl) },
    duration: program.duration || program.mainSong?.duration || 0,
    description: program.description || "",
    published: published.getTime() > 0 ? published.toISOString().slice(0, 10) : "",
    url: `${SITE}/program?id=${programID}`, unavailable: !audioID,
  };
}

function trackIdentity(value) {
  const match = /^program:(\d+)(?::(\d+))?$/.exec(String(value));
  if (match) {
    const program = idOf(match[1]);
    return { program, audio: match[2] ? idOf(match[2]) : null, thread: `A_DJ_1_${program}` };
  }
  const audio = idOf(value);
  return { audio, thread: `R_SO_4_${audio}` };
}

function toComment(comment) {
  const quote = (comment.beReplied || []).map(reply =>
    `${reply.user?.nickname || ""}：${reply.content || ""}`).join("\n");
  return {
    id: String(comment.commentId), author: comment.user?.nickname || "",
    avatarUrl: artworkURL(comment.user?.avatarUrl),
    text: (comment.content || "") + (quote ? `\n\n回复：${quote}` : ""),
    time: comment.time || 0, likes: comment.likedCount || 0, liked: !!comment.liked,
  };
}

function toUserLink(user = {}) {
  const stats = [];
  if (Number.isFinite(user.follows)) stats.push(`关注 ${user.follows}`);
  if (Number.isFinite(user.followeds)) stats.push(`粉丝 ${user.followeds}`);
  const subtitle = [String(user.signature || "").trim(), stats.join(" · ")].filter(Boolean).join(" · ");
  return {
    title: user.nickname || `用户 ${user.userId}`,
    subtitle,
    imageUrl: artworkURL(user.avatarUrl),
    page: `user:${idOf(user.userId)}`,
  };
}

async function songDetails(ids, originals = [], options = {}) {
  if (!ids.length) return [];
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    batches.push(ids.slice(offset, offset + 400));
  }
  const results = await Promise.all(batches.map(async (batch) => {
    const data = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id: Number(idOf(id)) }))) }, options);
    const privileges = new Map((data.privileges || []).map((p) => [String(p.id), p]));
    return (data.songs || []).map((song) => ({ ...song, privilege: privileges.get(String(song.id)) || song.privilege }));
  }));
  const byID = new Map(results.flat().map((song) => [String(song.id), song]));
  const fallback = new Map(originals.map((song) => [String(song.id), song]));
  // MyGo advances offset by the number of returned tracks. Keep a slot for
  // every requested ID, including songs removed from the detail response.
  return ids.map((id) => byID.get(String(id)) || {
    ...(fallback.get(String(id)) || { id, name: "歌曲暂不可用" }),
    privilege: { st: -1, pl: 0 },
  });
}

async function profileFor(activeSession) {
  const data = await request("/api/nuser/account/get", {}, { session: activeSession });
  const profile = activeSession.cookies.MUSIC_U ? data.profile : null;
  if (!profile) return null;
  const id = String(profile.userId);
  return { id, name: profile.nickname, imageUrl: artworkURL(profile.avatarUrl), page: `user:${id}` };
}

export async function account() {
  const activeSession = currentSession();
  if (!activeSession.cookies.MUSIC_U) return null;
  if (activeSession.profile && Date.now() - profileCheckedAt < 60000) {
    if (!activeSession.profile.page && activeSession.profile.id) {
      activeSession.profile = { ...activeSession.profile, page: `user:${activeSession.profile.id}` };
    }
    return activeSession.profile;
  }
  try {
    const profile = await profileFor(activeSession);
    // A QR login can finish without another epoch change. Do not apply the
    // previous account's profile or sign-out to that newly accepted session.
    if (activeSession !== session) throw new Error("账号状态已改变，请重试");
    if (!profile) { clearSession(); return null; }
    activeSession.profile = profile;
    profileCheckedAt = Date.now();
    persistSession();
    return profile;
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

async function requireAccount() {
  const profile = await account();
  if (!profile) throw fail("signIn", "请先扫码登录网易云音乐");
  return profile;
}

export async function signIn() {
  const pending = { cookies: {}, profile: null };
  // Type 3 matches the desktop login code; the web QR flow rejects without one.
  const key = await eapi("/api/login/qrcode/unikey", { type: 3 }, { session: pending });
  if (!key.unikey) throw new Error("无法生成网易云登录二维码");
  host.signInPrompt({ qr: `https://music.163.com/login?codekey=${encodeURIComponent(key.unikey)}`, text: "请使用网易云音乐手机 App 扫码登录" });
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await eapi("/api/login/qrcode/client/login", { key: key.unikey, type: 3 }, {
      session: pending, codes: [800, 801, 802, 803],
    });
    if (result.code === 800) throw new Error("二维码已过期，请重新扫码");
    if (result.code === 802) host.signInPrompt({ qr: `https://music.163.com/login?codekey=${encodeURIComponent(key.unikey)}`, text: "已扫码，请在手机上确认登录" });
    if (result.code === 803) {
      if (!pending.cookies.MUSIC_U) throw new Error("网易云未返回有效会话，请重新扫码登录");
      const profile = await profileFor(pending);
      if (!profile) throw new Error("已扫码，但未能读取网易云账号信息");
      epoch++;
      session = { cookies: pending.cookies, profile };
      profileCheckedAt = Date.now();
      likedCache = null;
      pendingStreams.clear();
      heartState = null;
      pendingHeart = null;
      persistSession();
      return profile;
    }
  }
  throw new Error("登录已超时，请重试");
}

export function signOut() {
  clearSession();
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const types = {
    tracks: [1, "songs", "songCount", toTrack], albums: [10, "albums", "albumCount", toAlbum],
    artists: [100, "artists", "artistCount", toArtist], playlists: [1000, "playlists", "playlistCount", toPlaylist],
    shows: [1009, "djRadios", "djRadiosCount", toShow],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", "支持歌曲、专辑、歌手、歌单和播客搜索");
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  offset = pageOffset(offset);
  const data = await request("/api/cloudsearch/pc", { s: text, type: type[0], limit: PAGE_SIZE, offset, total: "true" });
  const result = data.result || {};
  const items = result[type[1]] || [];
  const records = kind === "tracks" ? await songDetails(items.map((song) => song.id), items) : items;
  return { [kind]: records.map(type[3]), more: items.length > 0 && offset + items.length < (result[type[2]] || 0) };
}

export async function suggest({ query }) {
  const text = String(query || "").trim();
  if (!text) return [];
  const data = await request("/api/search/suggest/keyword", { s: text });
  return (data.result?.allMatch || []).map(item => String(item.keyword || "").trim()).filter(Boolean);
}

async function discoveryPlaylists() {
  const data = await request("/api/personalized/playlist", { limit: 24 });
  const items = (data.result || []).map(toPlaylist);
  discoveryCovers = items.map(item => item.imageUrl).filter(Boolean);
  return items;
}

function discoveryCover(index) {
  return discoveryCovers?.length ? discoveryCovers[index % discoveryCovers.length] : "";
}

async function discoverySection() {
  try {
    return { title: "推荐歌单", playlists: await discoveryPlaylists(), morePage: "discovery" };
  } catch (error) {
    if (error.code === "signIn") throw error;
    // Keep the remaining home sections and stations available when the
    // recommendation feed fails transiently.
    return { title: "推荐歌单", empty: "推荐歌单暂时加载失败，点「查看全部」重试", morePage: "discovery" };
  }
}

export async function home() {
  const recommendations = await discoverySection();
  return {
    title: "发现音乐",
    sections: [
      {
        title: "为你推荐",
        links: [
          { title: "每日推荐", subtitle: "登录账号查看今日推荐歌曲", imageUrl: discoveryCover(0), page: "daily" },
          { title: "私人雷达", subtitle: "登录账号同步你的常听歌单", imageUrl: discoveryCover(1), page: "radar" },
          { title: "个性化歌单", subtitle: "登录账号获取每日推荐歌单", imageUrl: discoveryCover(2), page: "recommendations" },
        ],
      },
      {
        title: "我的记录",
        links: [
          { title: "音乐云盘", subtitle: "登录账号浏览云盘歌曲", imageUrl: discoveryCover(3), page: "cloud:0" },
          { title: "最近一周听歌排行", subtitle: "登录账号查看近一周最常听", imageUrl: discoveryCover(4), page: "record:week" },
          { title: "所有时间听歌排行", subtitle: "登录账号查看累计最常听", imageUrl: discoveryCover(5), page: "record:all" },
          { title: "我的关注", subtitle: "查看关注的用户及 TA 的歌单", imageUrl: discoveryCover(6), page: "following:0" },
        ],
      },
      recommendations,
    ],
  };
}

async function loadUserPlaylists(uid, options = {}) {
  const activeSession = options.session || currentSession();
  const generation = epoch;
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const data = await request("/api/user/playlist", { uid, limit: 200, offset }, {
      session: activeSession, keepSession: true,
    });
    if (options.checkSession) checkAccountSession(activeSession, generation);
    const items = data.playlist || [];
    result.push(...items);
    if (!data.more || items.length < 200) return result;
    if (offset >= 1800) throw new Error("账号歌单超过本版本支持的 2000 个，暂时无法完整加载");
  }
}

async function loadUserListPage(kind, uid, offset, prefix) {
  const isFollowing = kind === "following";
  const path = isFollowing ? `/api/user/getfollows/${uid}` : `/api/user/getfolloweds/${uid}`;
  const params = isFollowing ? { limit: PAGE_SIZE, offset, order: "true" } : { limit: PAGE_SIZE, offset };
  const data = await request(path, params, { keepSession: true });
  const list = isFollowing ? data.follow : data.followeds;
  if (!Array.isArray(list)) {
    throw new Error(isFollowing ? "网易云未返回有效的关注列表" : "网易云未返回有效的粉丝列表");
  }
  const links = list.filter(item => item?.userId).map(toUserLink);
  const morePage = data.more && list.length ? `${prefix}:${offset + list.length}` : "";
  return { links, morePage };
}

async function loadRecordPage(uid, week, isSelf) {
  const data = await request("/api/v1/play/record", { uid, type: week ? 1 : 0 }, { keepSession: true, codes: [200, -2] });
  const title = week ? "最近一周 · 听歌排行" : "所有时间 · 听歌排行";
  if (Number(data.code) === -2) {
    return { title, sections: [{ tracks: [], empty: isSelf ? "暂无听歌记录" : "该用户未公开听歌排行" }] };
  }
  const entries = data[week ? "weekData" : "allData"];
  if (!Array.isArray(entries)) throw new Error("网易云未返回有效的听歌排行");
  return {
    title,
    sections: [{ tracks: entries.filter(item => item.song?.id).map(item => toTrack(item.song)), empty: "暂无听歌记录" }],
  };
}

async function loadUserPage(uid) {
  const viewer = await account();
  const isSelf = !!viewer && viewer.id === uid;
  const [detail, rawPlaylists] = await Promise.all([
    request(`/api/v1/user/detail/${uid}`, {}, { keepSession: true }),
    loadUserPlaylists(uid, { keepSession: true }),
  ]);
  const user = detail.profile;
  if (!user) throw fail("unavailable", "用户不存在或主页不可访问");
  const created = rawPlaylists.filter(item => String(item.creator?.userId) === uid).map(toPlaylist);
  const collected = rawPlaylists.filter(item => String(item.creator?.userId) !== uid).map(toPlaylist);
  const stats = [];
  if (Number.isFinite(detail.level)) stats.push(`Lv.${detail.level}`);
  if (Number.isFinite(detail.listenSongs)) stats.push(`累计听歌 ${detail.listenSongs} 首`);
  if (Number.isFinite(user.follows)) stats.push(`关注 ${user.follows}`);
  if (Number.isFinite(user.followeds)) stats.push(`粉丝 ${user.followeds}`);
  const links = [
    { title: isSelf ? "我的关注" : "Ta 的关注", subtitle: Number.isFinite(user.follows) ? `${user.follows} 人` : "", page: `user-following:${uid}:0` },
    { title: isSelf ? "我的粉丝" : "Ta 的粉丝", subtitle: Number.isFinite(user.followeds) ? `${user.followeds} 人` : "", page: `user-followers:${uid}:0` },
    { title: "最近一周听歌排行", page: `record:${uid}:week` },
    { title: "所有时间听歌排行", page: `record:${uid}:all` },
  ];
  if (isSelf) {
    links.push(
      { title: "音乐云盘", page: "cloud:0" },
      { title: "关注的歌手", page: "followed-artists" },
    );
  }
  return {
    title: user.nickname || `用户 ${uid}`,
    subtitle: stats.join(" · "),
    imageUrl: artworkURL(user.avatarUrl),
    description: String(user.signature || "").trim(),
    sections: [
      { title: isSelf ? "我的空间" : "用户动态", links },
      { title: `创建的歌单（${created.length}）`, playlists: created, empty: "暂无公开创建的歌单" },
      { title: `收藏的歌单（${collected.length}）`, playlists: collected, empty: "暂无公开收藏的歌单" },
    ],
  };
}

export async function browse({ page }) {
  if (/^cloud:\d+$/.test(page)) {
    await requireAccount();
    const offset = pageOffset(Number(page.slice(6)));
    const data = await request("/api/v1/cloud/get", { limit: PAGE_SIZE, offset }, { keepSession: true });
    if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的云盘列表");
    const tracks = data.data.map(item => {
      // Private cloud songs may not exist in the public detail catalogue.
      const song = item.simpleSong || {};
      const track = toTrack({ ...song, id: item.songId, name: item.songName || song.name });
      if (!song.privilege) track.unavailable = false; // Stream still enforces access/trial checks.
      return track;
    });
    if (data.hasMore && !tracks.length) throw new Error("网易云未返回完整的云盘列表");
    return { title: "音乐云盘", sections: [{ tracks, empty: "云盘暂无歌曲", morePage: data.hasMore ? `cloud:${offset + tracks.length}` : "" }] };
  }
  if (/^(following|followers):\d+$/.test(page)) {
    const profile = await requireAccount();
    const [kind, rawOffset] = page.split(":");
    const offset = pageOffset(Number(rawOffset));
    const { links, morePage } = await loadUserListPage(kind, profile.id, offset, kind);
    return {
      title: kind === "following" ? "我的关注" : "我的粉丝",
      sections: [{ links, morePage, empty: kind === "following" ? "你还没有关注任何用户" : "还没有粉丝" }],
    };
  }
  const userListMatch = /^user-(following|followers):(\d+):(\d+)$/.exec(page);
  if (userListMatch) {
    const [, kind, rawUid, rawOffset] = userListMatch;
    const uid = idOf(rawUid);
    const offset = pageOffset(Number(rawOffset));
    const prefix = `user-${kind}:${uid}`;
    const { links, morePage } = await loadUserListPage(kind, uid, offset, prefix);
    return {
      title: kind === "following" ? "关注的用户" : "粉丝列表",
      sections: [{ links, morePage, empty: kind === "following" ? "暂无关注的用户" : "暂无粉丝" }],
    };
  }
  if (/^user:\d+$/.test(page)) {
    return loadUserPage(idOf(page.slice(5)));
  }
  const userRecordMatch = /^record:(\d+):(week|all)$/.exec(page);
  if (userRecordMatch) {
    const uid = idOf(userRecordMatch[1]);
    const viewer = await account();
    return loadRecordPage(uid, userRecordMatch[2] === "week", !!viewer && viewer.id === uid);
  }
  if (page === "record:week" || page === "record:all") {
    const profile = await requireAccount();
    return loadRecordPage(profile.id, page === "record:week", true);
  }
  if (page === "followed-artists") {
    await requireAccount();
    const artists = new Map();
    for (let offset = 0; offset < 2000;) {
      const data = await request("/api/artist/sublist", { limit: 100, offset, total: "true" }, { keepSession: true });
      const items = data.data || [];
      const previousSize = artists.size;
      for (const item of items) artists.set(String(item.id), { ...toArtist(item), following: true });
      if (!data.hasMore || !items.length || artists.size === previousSize) break;
      offset += items.length;
    }
    return { title: "关注的歌手", sections: [{ artists: [...artists.values()], empty: "暂无关注的歌手" }] };
  }
  if (page === "discovery") {
    return { title: "推荐歌单", sections: [{ playlists: await discoveryPlaylists(), empty: "暂时没有推荐歌单" }] };
  }
  if (page === "radar") {
    // NetEase's dynamic playlist is selected for the signed-in listener.
    // Never label its anonymous response as someone's personal radar.
    await requireAccount();
    const radar = await playlist({ id: PRIVATE_RADAR });
    return { title: "私人雷达", subtitle: radar.name, sections: [{ tracks: radar.tracks }] };
  }
  if (page === "daily") {
    await requireAccount();
    const data = await request("/api/v3/discovery/recommend/songs");
    const songs = data.data?.dailySongs || [];
    return { title: "每日推荐", sections: [{ tracks: (await songDetails(songs.map(song => song.id), songs)).map(toTrack) }] };
  }
  if (page === "recommendations") {
    await requireAccount();
    const data = await request("/api/v1/discovery/recommend/resource");
    return { title: "个性化歌单", sections: [{ playlists: (data.recommend || []).map(toPlaylist) }] };
  }
  if (page !== "charts") throw fail("unsupported", "没有这个页面");
  const data = await request("/api/toplist/detail");
  return { title: "排行榜", sections: [{ playlists: (data.list || []).map(toPlaylist) }] };
}

export async function playlists() {
  const activeSession = currentSession();
  const generation = epoch;
  const profile = await account();
  if (!profile) return [];
  checkAccountSession(activeSession, generation);
  const raw = await loadUserPlaylists(profile.id, { session: activeSession, checkSession: true });
  return raw.map(toPlaylist);
}

export async function playlist({ id }) {
  const data = await request("/api/v6/playlist/detail", { id: idOf(id), n: PLAYLIST_LIMIT });
  if (!data.playlist) throw fail("unavailable", "歌单不存在或当前账号无权访问");
  const source = data.playlist;
  const ids = (source.trackIds || source.tracks || []).slice(0, PLAYLIST_LIMIT).map((track) => track.id);
  const result = toPlaylist(source);
  result.tracks = (await songDetails(ids, source.tracks || [])).map(toTrack);
  if (source.trackCount > PLAYLIST_LIMIT) {
    result.description += `\n本版本载入前 ${PLAYLIST_LIMIT} 首（歌单共 ${source.trackCount} 首）。`;
  }
  return result;
}

export async function createPlaylist({ name }) {
  const title = String(name || "").trim();
  if (!title) throw new Error("请输入歌单名称");
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  const data = await eapi("/api/playlist/create", { name: title, privacy: "0", type: "NORMAL" }, {
    session: activeSession, keepSession: true,
  });
  checkAccountSession(activeSession, generation);
  const created = data.playlist || { id: data.id, name: title, creator: { userId: activeSession.profile?.id } };
  if (!created.id) throw new Error("创建歌单失败，请稍后重试");
  return toPlaylist(created);
}

export async function renamePlaylist({ id, name }) {
  const pid = idOf(id);
  const title = String(name || "").trim();
  if (!title) throw new Error("请输入歌单名称");
  await toggleSubscription("/api/playlist/update/name", { id: pid, name: title });
}

export async function deletePlaylist({ id }) {
  const pid = idOf(id);
  await toggleSubscription("/api/playlist/remove", { ids: JSON.stringify([Number(pid)]) });
}

export async function savePlaylist({ id, on }) {
  await toggleSubscription(on ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe", { id: idOf(id) });
}

export async function savedAlbums({ offset = 0 }) {
  offset = pageOffset(offset);
  await requireAccount();
  const data = await request("/api/album/sublist", { limit: PAGE_SIZE, offset }, { keepSession: true });
  if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的收藏专辑列表");
  return { albums: data.data.map(toAlbum), more: !!data.hasMore };
}

export async function saveAlbum({ id, on }) {
  await toggleSubscription(on ? "/api/album/sub" : "/api/album/unsub", { id: idOf(id) });
}

export async function followArtist({ id, on }) {
  const artistID = idOf(id);
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  // Desktop EAPI artist-follow requests can hit -460; the web form endpoint works reliably.
  const form = new URLSearchParams({ artistId: artistID, artistIds: JSON.stringify([Number(artistID)]) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  await request(on ? "/api/artist/sub" : "/api/artist/unsub", {}, {
    session: activeSession, form: form.toString(), keepSession: true,
  });
  checkAccountSession(activeSession, generation);
}

export async function subscribeShow({ id, on }) {
  await toggleSubscription(on ? "/api/djradio/sub" : "/api/djradio/unsub", { id: idOf(id) });
}

async function toggleSubscription(path, params) {
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  await eapi(path, params, { session: activeSession, keepSession: true });
  checkAccountSession(activeSession, generation);
}

// Some subscription responses ignore offset. Recover via a larger prefix,
// but only claim completeness when the server explicitly ends the list.
async function completeShowPrefix(previousSize, limit) {
  for (;;) {
    const data = await request("/api/djradio/get/subed", { limit, offset: 0, total: "true" }, { keepSession: true });
    if (!Array.isArray(data.djRadios)) throw new Error("网易云未返回有效的播客订阅列表");
    const unique = new Map(data.djRadios.map(item => [String(item.id), { ...toShow(item), subscribed: true }]));
    if (data.hasMore === false) return [...unique.values()];
    if (unique.size <= previousSize || limit >= 2000) throw new Error("网易云未返回完整的播客订阅列表，请稍后重试");
    previousSize = unique.size;
    limit = Math.min(2000, limit * 2);
  }
}

export async function shows() {
  await requireAccount();
  const result = new Map();
  let duplicatePages = 0;
  for (let offset = 0; offset < 2000;) {
    const data = await request("/api/djradio/get/subed", { limit: 100, offset, total: "true" }, { keepSession: true });
    const items = data.djRadios || [];
    const previousSize = result.size;
    for (const item of items) result.set(String(item.id), { ...toShow(item), subscribed: true });
    if (!data.hasMore) return [...result.values()];
    // A changing subscription list can overlap a page. Advance by the raw
    // count once, then recover via a bounded prefix if offset stays stuck.
    duplicatePages = result.size === previousSize ? duplicatePages + 1 : 0;
    if (!items.length || duplicatePages > 1) {
      return completeShowPrefix(result.size, Math.min(2000, Math.max(200, offset * 2)));
    }
    offset += items.length;
  }
  throw new Error("播客订阅超过本版本支持的 2000 个，暂时无法完整加载");
}

export async function show({ id, offset = 0 }) {
  id = idOf(id);
  offset = pageOffset(offset);
  const [detail, programs] = await Promise.all([
    request("/api/djradio/v2/get", { id }, { keepSession: true }),
    request("/api/dj/program/byradio", { radioId: id, limit: PAGE_SIZE, offset, asc: "false" }, { keepSession: true }),
  ]);
  if (!detail.data || String(detail.data.id) !== id) throw fail("unavailable", "播客不存在或当前账号无权访问");
  return {
    show: toShow(detail.data),
    episodes: (programs.programs || []).map(program => toEpisode(program, detail.data)),
    more: !!programs.more,
  };
}

export async function album({ id }) {
  const data = await request(`/api/v1/album/${idOf(id)}`);
  if (!data.album) throw fail("unavailable", "专辑不可用");
  return { album: toAlbum(data.album), tracks: (await songDetails((data.songs || []).map((song) => song.id), data.songs || [])).map(toTrack) };
}

async function artistAlbums(id) {
  // The host has no artist-album pagination action. Collect every page here,
  // advancing by raw page length so overlapping albums do not shift offsets.
  const albums = new Map();
  for (let offset = 0; offset < 10000;) {
    const data = await request(`/api/artist/albums/${id}`, { limit: PAGE_SIZE, offset });
    const items = data.hotAlbums || [];
    const previousSize = albums.size;
    for (const item of items) albums.set(String(item.id), toAlbum(item));
    if (!data.more) return [...albums.values()];
    if (!items.length || albums.size === previousSize) {
      throw new Error("网易云未返回完整的歌手专辑列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("歌手专辑过多，暂时无法完整加载");
}

export async function artist({ id }) {
  id = idOf(id);
  const [detail, albums] = await Promise.all([
    request(`/api/v1/artist/${id}`), artistAlbums(id),
  ]);
  if (!detail.artist) throw fail("unavailable", "歌手不可用");
  return {
    artist: toArtist(detail.artist), albums,
    tracks: (await songDetails((detail.hotSongs || []).map((song) => song.id), detail.hotSongs || [])).map(toTrack),
  };
}

async function likedIDs() {
  const activeSession = currentSession();
  const generation = epoch;
  const profile = await requireAccount();
  checkAccountSession(activeSession, generation);
  if (likedCache && likedCache.uid === profile.id && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const revision = likedRevision;
  const data = await eapi("/api/song/like/get", { uid: profile.id }, { session: activeSession, keepSession: true });
  checkAccountSession(activeSession, generation);
  if (revision !== likedRevision) throw new Error("喜欢状态已更新，请重试");
  const ids = (data.ids || []).map(String);
  likedCache = { uid: profile.id, ids, at: Date.now() };
  return ids;
}

export async function liked({ offset = 0 }) {
  offset = pageOffset(offset);
  const ids = await likedIDs();
  return { tracks: (await songDetails(ids.slice(offset, offset + PAGE_SIZE))).map(toTrack), more: offset + PAGE_SIZE < ids.length };
}

export async function isLiked({ ids }) {
  const identities = ids.map(id => ({ id, ...trackIdentity(id) }));
  const songs = identities.filter(item => !item.program);
  const result = Object.fromEntries(ids.map(id => [id, false]));
  // The host also asks about episode IDs. We keep episode likes disabled unless likeEpisode is added.
  if (!songs.length) return result;
  currentSession();
  if (!session.cookies.MUSIC_U) return result;
  const liked = new Set(await likedIDs());
  for (const item of songs) result[item.id] = liked.has(item.audio);
  return result;
}

export async function like({ id, on }) {
  const identity = trackIdentity(id);
  if (identity.program) throw fail("unsupported", "暂不支持喜欢或取消喜欢播客节目");
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  await eapi("/api/radio/like", { alg: "itembased", trackId: identity.audio, like: String(!!on), time: "3" }, {
    session: activeSession, keepSession: true,
  });
  checkAccountSession(activeSession, generation);
  likedRevision++;
  likedCache = null;
}

function checkAccountSession(activeSession, generation) {
  if (generation !== epoch || activeSession !== session) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function submitPlaylistTracks(op, id, ids, activeSession, generation) {
  checkAccountSession(activeSession, generation);
  const form = new URLSearchParams({ op, pid: id, imme: "true", trackIds: JSON.stringify(ids.map(Number)) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  try {
    const data = await request("/api/playlist/manipulate/tracks", {}, {
      session: activeSession, form: form.toString(), keepSession: true, codes: [200, 502],
    });
    checkAccountSession(activeSession, generation);
    return data;
  } catch (error) {
    // Preserve signIn so the host can offer login; a content 401 keeps session.
    error.message = `${op === "add" ? "添加到歌单" : "移出歌单"}失败：${error.message}`;
    throw error;
  }
}

async function playlistTrackIDs(id, activeSession, generation) {
  checkAccountSession(activeSession, generation);
  const data = await request("/api/v6/playlist/detail", { id, n: PLAYLIST_LIMIT }, {
    session: activeSession, keepSession: true,
  });
  checkAccountSession(activeSession, generation);
  const source = data.playlist;
  if (String(source?.id) !== id || !Array.isArray(source.trackIds) || source.trackIds.length < source.trackCount) {
    throw new Error("无法确认歌单的完整歌曲列表，请刷新后重试");
  }
  return new Set(source.trackIds.map(track => String(track.id)));
}

async function manipulatePlaylistTracks(op, id, trackIds) {
  const pid = String(Number(idOf(id)));
  if (trackIds == null) trackIds = [];
  if (!Array.isArray(trackIds)) throw new Error("无效的歌曲列表");
  const ids = [...new Set(trackIds.map(value => {
    const identity = trackIdentity(value);
    if (identity.program) throw fail("unsupported", "暂不支持将播客节目添加到歌曲歌单或从中移除");
    return String(Number(identity.audio));
  }))];
  if (!ids.length) return;
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  let data = await submitPlaylistTracks(op, pid, ids, activeSession, generation);
  if (op === "add" && Number(data.code) === 502) {
    // A duplicate rejects the whole batch. Only retry songs proved absent;
    // never treat an unexplained 502 or a concurrent edit as successful.
    const present = await playlistTrackIDs(pid, activeSession, generation);
    const missing = ids.filter(trackID => !present.has(trackID));
    if (!missing.length) {
      throw fail("duplicate", ids.length === 1 ? "这首歌已经在这个歌单里了" : "这些歌曲已经在这个歌单里了");
    }
    if (missing.length < ids.length) {
      data = await submitPlaylistTracks(op, pid, missing, activeSession, generation);
    }
  }
  if (Number(data.code) !== 200) {
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}未完成（${data.code}），请刷新歌单后重试`);
  }
  likedCache = null;
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("del", id, trackIds);
}

export async function comments({ trackId, offset = 0 }) {
  const identity = trackIdentity(trackId);
  offset = pageOffset(offset);
  const activeSession = currentSession();
  if (!commentSnapshot || commentSnapshot.thread !== identity.thread ||
      commentSnapshot.session !== activeSession || commentSnapshot.epoch !== epoch || offset === 0) {
    const hot = await request(`/api/v1/resource/hotcomments/${identity.thread}`, {
      rid: identity.program || identity.audio, limit: 20, offset: 0, beforeTime: 0,
    }, { session: activeSession, keepSession: true });
    const items = (hot.hotComments || []).slice().sort((a, b) => (b.likedCount || 0) - (a.likedCount || 0)).slice(0, 20);
    const unique = new Map(items.map(item => [String(item.commentId), item]));
    commentSnapshot = { thread: identity.thread, session: activeSession, epoch, items: [...unique.values()], seen: new Set(unique.keys()), cursor: 0, more: true, total: 0 };
  }
  const state = commentSnapshot;
  // Host offsets count displayed comments, not raw chronological records.
  // Retain both cursors so overlap with hot comments never skips a record.
  const pending = (state.pending || Promise.resolve()).catch(() => {}).then(async () => {
    let stagnantPages = 0;
    for (let pages = 0; state.items.length < offset + PAGE_SIZE && state.more; pages++) {
      if (pages >= 50) throw new Error("评论分页过多，请重新打开评论后重试");
      const data = await request(`/api/v1/resource/comments/${identity.thread}`, {
        limit: PAGE_SIZE, offset: state.cursor,
      }, { session: activeSession, keepSession: true });
      if (!Array.isArray(data.comments) || (data.more && !data.comments.length)) throw new Error("网易云未返回完整的评论列表");
      const previousSize = state.items.length;
      for (const item of data.comments) {
        const id = String(item.commentId);
        if (!state.seen.has(id)) { state.seen.add(id); state.items.push(item); }
      }
      stagnantPages = state.items.length === previousSize ? stagnantPages + 1 : 0;
      if (data.more && stagnantPages >= 2) throw new Error("网易云未返回完整的评论列表，请稍后重试");
      state.cursor += data.comments.length;
      state.more = !!data.more;
      state.total = data.total || state.items.length;
    }
  });
  state.pending = pending;
  try { await pending; }
  finally { if (state.pending === pending) state.pending = null; }
  if (state.session !== session || state.epoch !== epoch) throw new Error("账号状态已改变，请重试");
  return { comments: state.items.slice(offset, offset + PAGE_SIZE).map(toComment), total: state.total, more: offset + PAGE_SIZE < state.items.length || state.more };
}

// Word-timed lyrics (yrc) are served only by the desktop endpoint, and only
// to a signed-in listener: each line carries the span it is sung over, and
// each word, a character for CJK, its own. The web endpoint never carries
// them. A yrc row reads [start, length](start, length, 0)word…, times in
// milliseconds.
function parseYRC(text) {
  const lines = [];
  for (const row of String(text || "").split(/\r?\n/)) {
    const line = /^\[(\d+),(\d+)\](.*)$/.exec(row);
    if (!line) continue;
    const marks = [];
    const pattern = /\((\d+),(\d+),[^)]*\)/g;
    for (let mark; (mark = pattern.exec(line[3])); ) {
      marks.push({ at: mark.index, after: pattern.lastIndex, start: Number(mark[1]), end: Number(mark[1]) + Number(mark[2]) });
    }
    const words = marks
      .map((mark, i) => ({ start: mark.start, end: mark.end, text: line[3].slice(mark.after, marks[i + 1]?.at) }))
      .filter((word) => word.text);
    if (words.length) {
      lines.push({ start: Number(line[1]), end: Number(line[1]) + Number(line[2]), text: words.map((word) => word.text).join(""), words });
    }
  }
  return lines;
}

// A word-timed translation arrives as plain timed lines of its own; the one
// nearest to a line's start, within half a second, is that line's translation.
function alignTranslations(lines, timed) {
  const byTime = [];
  for (const row of String(timed || "").split(/\r?\n/)) {
    const text = row.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    const pattern = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
    for (let match; (match = pattern.exec(row)); ) {
      byTime.push({ start: Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || "").padEnd(3, "0").slice(0, 3)), text });
    }
  }
  for (const line of lines) {
    const nearest = byTime
      .filter((item) => Math.abs(item.start - line.start) <= 500)
      .sort((a, b) => Math.abs(a.start - line.start) - Math.abs(b.start - line.start))[0];
    if (nearest?.text) line.translation = nearest.text;
  }
  return lines;
}

// What a desktop lyric answer becomes: word-timed lines when it has yrc, with
// the word-timed translation preferred and the line-wise one as the stand-in,
// and plain LRC otherwise.
function lyricAnswer(desktop, translation) {
  const lrc = desktop.lrc?.lyric || "";
  const lines = parseYRC(desktop.yrc?.lyric);
  if (!lines.length) return { lrc, translation };
  return { lines: alignTranslations(lines, desktop.ytlrc?.lyric || translation), lrc, translation };
}

export async function lyrics({ id }) {
  const identity = trackIdentity(id);
  if (identity.program) return { lrc: "", translation: "" };
  const activeSession = currentSession();
  const generation = epoch;
  const params = { id: identity.audio, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 };
  const options = { session: activeSession, keepSession: true };
  const checkSession = () => {
    if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  };
  const fromDesktop = async (translation = "") => {
    const desktop = await eapi("/api/song/lyric/v1", params, options);
    checkSession();
    return lyricAnswer(desktop, desktop.tlyric?.lyric || translation);
  };
  // Prefer word timing when signed in, but retain web lyrics if the desktop
  // service fails. Authentication and account changes must still propagate.
  let desktopAnswer, desktopError;
  if (activeSession.cookies.MUSIC_U) {
    try {
      desktopAnswer = await fromDesktop();
      if (desktopAnswer.lines || desktopAnswer.lrc.trim()) return desktopAnswer;
    } catch (error) {
      if (error.code === "signIn") throw error;
      checkSession();
      desktopError = error;
    }
  }
  const data = await request("/api/song/lyric", { id: identity.audio, lv: 1, tv: -1 }, options);
  checkSession();
  const lrc = data.lrc?.lyric || "";
  const translation = data.tlyric?.lyric || desktopAnswer?.translation || "";
  if (lrc.trim()) return { lrc, translation };
  // Carry the web translation into the desktop fallback, even when the web
  // response has no original lyrics. Do not retry a failed desktop lookup.
  if (desktopError) throw desktopError;
  if (!desktopAnswer) return fromDesktop(translation);
  return { lrc: "", translation };
}

export async function stream({ id, quality = "high" }) {
  id = trackIdentity(id).audio;
  if (!id) throw fail("unavailable", "该播客节目没有可播放的音频");
  const generation = epoch;
  const key = `${generation}:${id}:${quality}`;
  const pending = pendingStreams.get(key) || loadStream(id, quality, generation);
  pendingStreams.set(key, pending);
  try {
    const result = await pending;
    // Every waiter must recheck after resuming, including shared requests.
    if (generation !== epoch) throw new Error("账号状态已改变，请重试");
    return result;
  }
  finally { if (pendingStreams.get(key) === pending) pendingStreams.delete(key); }
}

async function loadStream(id, quality, generation) {
  const level = { standard: "standard", high: "exhigh", lossless: "lossless" }[quality] || "exhigh";
  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (generation !== epoch) throw new Error("账号状态已改变，请重试");
    try {
      data = await eapi("/api/song/enhance/player/url/v1", {
        ids: JSON.stringify([Number(id)]), level, encodeType: level === "lossless" ? "flac" : "mp3",
      });
      break;
    } catch (error) {
      if (![460, -460].includes(error.neteaseCode)) throw error;
      if (attempt === 1) {
        const refused = new Error(`[${error.neteaseCode}] 网易云仍拒绝播放请求，请稍后再试，并在官方客户端确认该歌曲可正常播放`);
        refused.neteaseCode = error.neteaseCode;
        throw refused;
      }
      // One delayed retry of this read only, with the same device/account and
      // quality. Never retry account mutations or turn permission failures
      // into a different source, a preview, or a lower-quality success.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const audio = (data.data || []).find((item) => String(item.id) === id);
  if (!audio || !audio.url || (audio.code !== undefined && audio.code !== 200) || audio.freeTrialInfo != null) {
    throw fail("unavailable", "当前账号无完整播放权限，或歌曲在当前地区不可用");
  }
  const url = new URL(secureURL(audio.url));
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*music\.126\.net$/i.test(url.hostname)) {
    throw fail("unavailable", "网易云返回了不支持的音频地址");
  }
  const type = String(audio.type || "mp3").toLowerCase();
  if (!["mp3", "flac", "ogg", "m4a", "mp4", "aac"].includes(type)) throw fail("unavailable", "该歌曲的音频格式暂不支持");
  return {
    url: url.toString(), type, size: audio.size || 0, bitRate: audio.br || 0,
    quality: ["lossless", "hires"].includes(audio.level) ? "lossless" : audio.level === "standard" ? "standard" : "high",
    gain: audio.gain || 0, peak: audio.peak || 0,
    headers: { "User-Agent": UA, Referer: `${SITE}/` },
  };
}

// The host asks stationNext again as the queue runs out. These modes are
// NetEase's own recommendations, not a shuffle of the current local list.
function stationList() {
  return [
    { id: "DEFAULT", name: "私人漫游", description: "随心听，持续推荐你可能喜欢的歌曲" },
    { id: "FAMILIAR", name: "熟悉的歌", description: "回到熟悉的旋律" },
    { id: "EXPLORE", name: "新发现", description: "探索还没听过的音乐" },
  ].map((station, index) => ({
    ...station,
    // Older hosts replace source errors with a generic toast, so keep the
    // prerequisite visible on the station card as well.
    description: `${station.description}。需在网易云 App 中开启「个性化服务」。`,
    imageUrl: discoveryCover(index + 3),
  }));
}

export async function stations() {
  if (discoveryCovers === null) await discoverySection();
  return stationList();
}

// Candidate only: HEART is deliberately absent from stationList until live
// account and continuation checks pass. This uses NetEase's intelligence API,
// never the FAMILIAR radio or a local shuffle as a substitute.
function checkHeartAccount(activeSession, generation) {
  if (activeSession !== session || generation !== epoch) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function startHeart(activeSession, generation, profile) {
  const list = await loadUserPlaylists(profile.id, { session: activeSession, checkSession: true });
  const likedPlaylist = list.find(item => item && Number(item.specialType) === 5 &&
    String(item.creator?.userId) === profile.id);
  if (!likedPlaylist) throw fail("unavailable", "未找到当前账号的喜欢歌单，暂时无法开启心动模式");
  const playlistID = idOf(likedPlaylist.id);
  const data = await request("/api/v6/playlist/detail", { id: playlistID, n: 1 }, {
    session: activeSession, keepSession: true,
  });
  checkHeartAccount(activeSession, generation);
  const playlist = data.playlist;
  if (!playlist || String(playlist.id) !== playlistID || Number(playlist.specialType) !== 5 ||
      String(playlist.creator?.userId) !== profile.id) {
    throw fail("unavailable", "无法确认当前账号的喜欢歌单");
  }
  const tracks = playlist.trackIds || playlist.tracks;
  if (!Array.isArray(tracks)) throw new Error("网易云未返回喜欢歌单的歌曲列表");
  if (!tracks.length) throw fail("unavailable", "喜欢歌单为空，请先在网易云喜欢一首歌曲");
  const seedTrack = tracks.find(track => track && /^\d+$/.test(String(track.id)) &&
    Number.isSafeInteger(Number(track.id)) && Number(track.id) > 0);
  if (!seedTrack) throw fail("unavailable", "喜欢歌单没有可用的种子歌曲");
  const seed = idOf(seedTrack.id);
  return { uid: profile.id, generation, playlistID, seed, last: seed, seen: [] };
}

async function loadHeart(activeSession, generation) {
  const profile = await requireAccount();
  checkHeartAccount(activeSession, generation);
  const state = heartState?.generation === generation && heartState.uid === profile.id
    ? heartState : await startHeart(activeSession, generation, profile);
  checkHeartAccount(activeSession, generation);
  const seen = new Set(state.seen);
  let cursor = state.last;
  // Advance over repeated batches, but do not loop indefinitely if the
  // service cannot supply a new recommendation or stops advancing its cursor.
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await eapi("/api/playmode/intelligence/list", {
      songId: cursor, startMusicId: state.seed, playlistId: state.playlistID,
      type: "fromPlayOne", count: 1,
    }, { session: activeSession, keepSession: true });
    checkHeartAccount(activeSession, generation);
    if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的心动推荐列表");
    const songs = [];
    let nextCursor = cursor;
    for (const item of data.data) {
      // Removed songs can leave null entries or empty songInfo records.
      if (item == null) continue;
      if (typeof item !== "object") throw new Error("网易云返回了无效的心动推荐歌曲");
      if (item.songInfo == null) continue;
      const id = idOf(item.songInfo.id);
      nextCursor = id;
      if (!seen.has(id)) { seen.add(id); songs.push(item.songInfo); }
    }
    if (songs.length) {
      const ids = songs.map(song => idOf(song.id));
      const tracks = (await songDetails(ids, songs, { session: activeSession, keepSession: true })).map(toTrack);
      checkHeartAccount(activeSession, generation);
      heartState = { ...state, last: nextCursor, seen: [...seen].slice(-200) };
      return tracks;
    }
    // No new tracks need resolving; retain the service's cursor so the next
    // invocation does not restart at the original repeated batch.
    heartState = { ...state, last: nextCursor };
    if (nextCursor === cursor) break;
    cursor = nextCursor;
  }
  throw fail("unavailable", "网易云暂未返回新的心动推荐，请稍后重试");
}

async function heartNext() {
  const activeSession = currentSession();
  const generation = epoch;
  if (pendingHeart?.session === activeSession && pendingHeart.generation === generation) {
    return pendingHeart.promise;
  }
  const pending = { session: activeSession, generation, promise: loadHeart(activeSession, generation) };
  pendingHeart = pending;
  try { return await pending.promise; }
  finally { if (pendingHeart === pending) pendingHeart = null; }
}

export async function stationNext({ id }) {
  if (id === "HEART") return heartNext();
  if (!["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)) throw fail("unsupported", "没有这个漫游模式");
  await requireAccount();
  const data = await eapi("/api/v1/radio/get", { mode: id, limit: 3 });
  const songs = data.data || [];
  if (songs.length === 0) {
    let personalizationDisabled = false;
    try {
      const preferences = await request("/api/user/setting", {}, { keepSession: true });
      personalizationDisabled = preferences.setting?.personalServiceSetting === 2;
    } catch (error) {
      // A diagnostic lookup must not turn a transient empty batch into a new
      // failure, but an expired session still needs the normal sign-in flow.
      if (error.code === "signIn") throw error;
    }
    if (personalizationDisabled) {
      throw fail("unavailable", "网易云的「个性化服务」已关闭。请在官方 App 的「设置 → 消息和隐私 → 个性化服务」中开启后重试。");
    }
  }
  return (await songDetails(songs.map(song => song.id), songs)).map(toTrack);
}
