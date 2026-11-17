"""Instagram downloader API (FastAPI).

Resolves public Instagram post / reel / IGTV / carousel / profile / story links into
direct media items, and streams media through a host-restricted proxy so the
browser can preview and download it.
"""

from __future__ import annotations

import itertools
import os
import re
import threading
import time
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import instaloader
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="MediaKit Instagram downloader")

# ---------------------------------------------------------------------------
# Instaloader context (optionally logged in for stories / private-to-you content)
# ---------------------------------------------------------------------------
_L = instaloader.Instaloader(
    quiet=True,
    download_pictures=False,
    download_videos=False,
    save_metadata=False,
    max_connection_attempts=1,
    request_timeout=20,
)
_lock = threading.Lock()  # instaloader's context is not thread-safe
LOGGED_IN = False
IG_USER = os.environ.get("IG_USERNAME")
IG_SESSION = os.environ.get("IG_SESSION_FILE")
if IG_USER:
    try:
        _L.load_session_from_file(IG_USER, IG_SESSION)  # created with: instaloader -l USERNAME
        LOGGED_IN = True
    except Exception as e:  # noqa: BLE001
        print(f"[instagram] could not load session for {IG_USER}: {e}")

YTDLP_COOKIES = os.environ.get("IG_COOKIES_FILE")  # Netscape cookies.txt (optional)

# ---------------------------------------------------------------------------
# Small TTL cache to avoid hammering Instagram (and its rate limits)
# ---------------------------------------------------------------------------
_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 15 * 60


def cache_get(key: str) -> dict | None:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    _cache.pop(key, None)
    return None


def cache_put(key: str, value: dict) -> dict:
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.time(), value)
    return value


# ---------------------------------------------------------------------------
# URL parsing
# ---------------------------------------------------------------------------
POST_RE = re.compile(r"instagram\.com/(?:[\w.]+/)?(?:p|reel|reels|tv)/([\w-]{5,})", re.I)
STORY_RE = re.compile(r"instagram\.com/stories/([\w.]+)(?:/(\d+))?", re.I)
HIGHLIGHT_RE = re.compile(r"instagram\.com/stories/highlights/(\d+)", re.I)
PROFILE_RE = re.compile(r"instagram\.com/([\w.]{1,30})/?(?:\?|$)", re.I)
USERNAME_RE = re.compile(r"^@?([\w.]{1,30})$")
RESERVED = {"p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer", "legal"}


def classify(raw: str) -> tuple[str, dict]:
    s = raw.strip()
    if not s:
        raise HTTPException(400, "Paste an Instagram link first.")
    if "instagram.com" not in s.lower() and "instagr.am" not in s.lower():
        m = USERNAME_RE.match(s)
        if m:
            return "profile", {"username": m.group(1)}
        raise HTTPException(400, "That doesn't look like an Instagram link.")
    s = s.replace("instagr.am", "instagram.com")
    if m := HIGHLIGHT_RE.search(s):
        return "highlight", {"id": int(m.group(1))}
    if m := STORY_RE.search(s):
        return "story", {"username": m.group(1), "id": m.group(2)}
    if m := POST_RE.search(s):
        return "post", {"shortcode": m.group(1)}
    if (m := PROFILE_RE.search(s)) and m.group(1).lower() not in RESERVED:
        return "profile", {"username": m.group(1)}
    raise HTTPException(400, "Unsupported Instagram link. Use a post, reel, IGTV, story or profile link.")


# ---------------------------------------------------------------------------
# Resolvers
# ---------------------------------------------------------------------------
def friendly(e: Exception) -> HTTPException:
    msg = str(e)
    if isinstance(e, instaloader.exceptions.LoginRequiredException) or "login" in msg.lower():
        return HTTPException(403, "Instagram requires a login to view this content (private account, story, or age-restricted).")
    if isinstance(e, instaloader.exceptions.ProfileNotExistsException):
        return HTTPException(404, "That profile does not exist.")
    if isinstance(e, instaloader.exceptions.PrivateProfileNotFollowedException):
        return HTTPException(403, "This account is private.")
    if "429" in msg or "wait a few minutes" in msg.lower() or "rate" in msg.lower():
        return HTTPException(429, "Instagram is rate-limiting requests right now. Please try again in a few minutes.")
    if "404" in msg or "not found" in msg.lower() or isinstance(e, instaloader.exceptions.BadResponseException):
        return HTTPException(404, "Post not found. It may be deleted or private.")
    return HTTPException(502, f"Could not fetch from Instagram: {msg[:200]}")


def owner_of(post: instaloader.Post) -> dict:
    # Use the owner data embedded in the post; fetching the full profile costs extra
    # requests and is often throttled by Instagram.
    node = (getattr(post, "_node", {}) or {}).get("owner", {}) or {}
    return {"username": post.owner_username, "full_name": node.get("full_name", ""), "pic": node.get("profile_pic_url")}


def post_items(post: instaloader.Post) -> list[dict]:
    items = []
    if post.typename == "GraphSidecar":
        for i, n in enumerate(post.get_sidecar_nodes(), 1):
            items.append({
                "kind": "video" if n.is_video else "image",
                "url": n.video_url if n.is_video else n.display_url,
                "thumb": n.display_url,
                "name": f"{post.owner_username}_{post.shortcode}_{i}.{'mp4' if n.is_video else 'jpg'}",
            })
    else:
        items.append({
            "kind": "video" if post.is_video else "image",
            "url": post.video_url if post.is_video else post.url,
            "thumb": post.url,
            "name": f"{post.owner_username}_{post.shortcode}.{'mp4' if post.is_video else 'jpg'}",
        })
    return items


def product_type(post: instaloader.Post) -> str:
    node = getattr(post, "_node", {}) or {}
    return str(node.get("product_type") or "")


def resolve_post(shortcode: str) -> dict:
    try:
        with _lock:
            post = instaloader.Post.from_shortcode(_L.context, shortcode)
            data = {
                "type": "post",
                "subtype": "reel" if product_type(post) == "clips" else "igtv" if product_type(post) == "igtv" else
                           "carousel" if post.typename == "GraphSidecar" else "video" if post.is_video else "photo",
                "shortcode": shortcode,
                "owner": owner_of(post),
                "caption": post.caption or "",
                "date": post.date_utc.isoformat() + "Z",
                "likes": post.likes,
                "comments": post.comments,
                "views": post.video_view_count if post.is_video else None,
                "items": post_items(post),
            }
        return data
    except Exception as e:  # noqa: BLE001
        # Fallback: yt-dlp handles reels/videos well even when instaloader is blocked
        try:
            return resolve_with_ytdlp(f"https://www.instagram.com/p/{shortcode}/", shortcode)
        except Exception:  # noqa: BLE001
            raise friendly(e) from e


def resolve_with_ytdlp(url: str, shortcode: str) -> dict:
    opts: dict[str, Any] = {"quiet": True, "skip_download": True, "no_warnings": True}
    if YTDLP_COOKIES:
        opts["cookiefile"] = YTDLP_COOKIES
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    entries = info.get("entries") or [info]
    items = []
    for i, e in enumerate(entries, 1):
        fmts = [f for f in (e.get("formats") or []) if f.get("url") and f.get("vcodec") != "none" and f.get("protocol") in ("https", "http")]
        with_audio = [f for f in fmts if f.get("acodec") not in (None, "none")]
        pool = with_audio or fmts
        best = max(pool, key=lambda f: (f.get("height") or 0)) if pool else e
        if not best.get("url"):
            continue
        suffix = f"_{i}" if len(entries) > 1 else ""
        items.append({"kind": "video", "url": best.get("url"), "thumb": e.get("thumbnail"),
                      "name": f"{e.get('channel') or e.get('uploader_id') or 'instagram'}_{shortcode}{suffix}.mp4"})
    if not items:
        raise RuntimeError("no downloadable formats")
    return {
        "type": "post", "subtype": "video", "shortcode": shortcode,
        "owner": {"username": info.get("channel") or info.get("uploader_id") or "", "full_name": info.get("uploader") or "", "pic": None},
        "caption": info.get("description") or "", "date": None, "likes": info.get("like_count"),
        "comments": info.get("comment_count"), "views": info.get("view_count"), "items": items,
    }


def resolve_profile(username: str, limit: int = 12) -> dict:
    try:
        with _lock:
            p = instaloader.Profile.from_username(_L.context, username)
            posts = []
            if not p.is_private or p.followed_by_viewer:
                for post in itertools.islice(p.get_posts(), limit):
                    posts.append({
                        "shortcode": post.shortcode,
                        "thumb": post.url,
                        "kind": "carousel" if post.typename == "GraphSidecar" else "video" if post.is_video else "image",
                        "caption": (post.caption or "")[:120],
                    })
            node = getattr(p, "_node", {}) or {}
            pic_hd = node.get("profile_pic_url_hd") or p.profile_pic_url
            count = node.get("all_media_count") or (node.get("edge_owner_to_timeline_media") or {}).get("count") or p.mediacount
            return {
                "type": "profile",
                "owner": {"username": p.username, "full_name": p.full_name, "pic": pic_hd},
                "bio": p.biography,
                "followers": p.followers,
                "following": p.followees,
                "posts_count": count,
                "is_private": p.is_private,
                "is_verified": p.is_verified,
                "items": [{"kind": "image", "url": pic_hd, "thumb": pic_hd, "name": f"{p.username}_profile_picture.jpg"}],
                "posts": posts,
            }
    except Exception as e:  # noqa: BLE001
        raise friendly(e) from e


def story_item(s: instaloader.StoryItem) -> dict:
    return {
        "kind": "video" if s.is_video else "image",
        "url": s.video_url if s.is_video else s.url,
        "thumb": s.url,
        "name": f"{s.owner_username}_story_{s.mediaid}.{'mp4' if s.is_video else 'jpg'}",
        "date": s.date_utc.isoformat() + "Z",
    }


def resolve_story(username: str, story_id: str | None) -> dict:
    if not LOGGED_IN:
        raise HTTPException(403, "Stories and highlights need an Instagram login on the server. "
                                 "Set IG_USERNAME (and run `instaloader -l USERNAME` once) — see README.")
    try:
        with _lock:
            p = instaloader.Profile.from_username(_L.context, username)
            items = []
            for story in _L.get_stories(userids=[p.userid]):
                for s in story.get_items():
                    if story_id and str(s.mediaid) != story_id:
                        continue
                    items.append(story_item(s))
            if not items:
                raise HTTPException(404, "No active stories found (stories disappear after 24 hours).")
            return {"type": "story", "owner": {"username": p.username, "full_name": p.full_name, "pic": p.profile_pic_url}, "items": items}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise friendly(e) from e


def resolve_highlight(hid: int) -> dict:
    if not LOGGED_IN:
        raise HTTPException(403, "Highlights need an Instagram login on the server. See README.")
    try:
        with _lock:
            reel_id = f"highlight:{hid}"
            data = _L.context.get_iphone_json(f"api/v1/feed/reels_media/?reel_ids={reel_id}", {})
            reel = (data.get("reels") or {}).get(reel_id)
            if not reel:
                raise HTTPException(404, "Highlight not found.")
            owner = reel.get("user") or {}
            items = []
            for node in reel.get("items") or []:
                is_video = bool(node.get("video_versions"))
                url = (node["video_versions"][0]["url"] if is_video else node["image_versions2"]["candidates"][0]["url"])
                thumb = node["image_versions2"]["candidates"][0]["url"]
                items.append({"kind": "video" if is_video else "image", "url": url, "thumb": thumb,
                              "name": f"{owner.get('username', 'instagram')}_highlight_{node.get('pk')}.{'mp4' if is_video else 'jpg'}"})
            return {"type": "story", "owner": {"username": owner.get("username", ""), "full_name": reel.get("title", ""),
                                               "pic": owner.get("profile_pic_url")}, "items": items}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise friendly(e) from e


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
class ResolveIn(BaseModel):
    url: str


@app.post("/api/ig/resolve")
def resolve(body: ResolveIn) -> dict:
    kind, args = classify(body.url)
    key = f"{kind}:{args}"
    if cached := cache_get(key):
        return cached
    if kind == "post":
        data = resolve_post(args["shortcode"])
    elif kind == "profile":
        data = resolve_profile(args["username"])
    elif kind == "story":
        data = resolve_story(args["username"], args.get("id"))
    else:
        data = resolve_highlight(args["id"])
    return cache_put(key, data)


@app.get("/api/ig/status")
def status() -> dict:
    return {"logged_in": LOGGED_IN}


ALLOWED_HOST = re.compile(r"(^|\.)(cdninstagram\.com|fbcdn\.net)$", re.I)
SAFE_NAME = re.compile(r"[^\w.\-]+")


@app.get("/api/ig/media")
async def media(request: Request, u: str = Query(...), name: str = Query("instagram"), dl: int = 0):
    """Stream an Instagram CDN file. Only Instagram/Facebook CDN hosts are allowed."""
    host = urlparse(u).hostname or ""
    if urlparse(u).scheme != "https" or not ALLOWED_HOST.search(host):
        raise HTTPException(400, "Only Instagram media URLs can be fetched.")
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.instagram.com/"}
    if rng := request.headers.get("range"):
        headers["Range"] = rng  # lets <video> seek
    client = httpx.AsyncClient(timeout=60, follow_redirects=True)
    upstream = await client.send(client.build_request("GET", u, headers=headers), stream=True)
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(upstream.status_code, "The media link expired. Paste the Instagram link again.")
    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() in ("content-type", "content-length", "content-range", "accept-ranges")}
    out_headers["Cache-Control"] = "private, max-age=600"
    if dl:
        safe = SAFE_NAME.sub("_", name)[:120] or "instagram"
        out_headers["Content-Disposition"] = f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(safe)}"

    async def body():
        try:
            async for chunk in upstream.aiter_bytes(64 * 1024):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, headers=out_headers)


@app.exception_handler(HTTPException)
async def http_error(_req: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
