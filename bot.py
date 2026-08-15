import asyncio
import hashlib
import hmac
import json
import logging
import os
import random
import re
import sqlite3
from dataclasses import dataclass, field
from html import escape as h
from urllib.parse import parse_qsl

from aiogram import Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)
from aiohttp import web

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pharmabot")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(BASE_DIR, "progress.db")

TOKEN = os.environ.get("BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("Не задана переменная окружения BOT_TOKEN")

EXAM_TEST_COUNT = int(os.environ.get("EXAM_TEST_COUNT", 40))
EXAM_RECIPE_COUNT = int(os.environ.get("EXAM_RECIPE_COUNT", 20))

# Public HTTPS URL of the deployed web app (Railway domain, e.g. https://xxx.up.railway.app)
# Leave unset to fall back to the old in-chat button menu.
WEBAPP_URL = os.environ.get("WEBAPP_URL", "").rstrip("/")

# The actual live Mini App (GitHub Pages). Used for the /start web_app button —
# a message with a single web_app inline button is what makes Telegram show the
# "Открыть" quick-action button directly in the chat list, next to the bot's name.
MINIAPP_URL = os.environ.get("MINIAPP_URL", "https://maga2001baligov-bit.github.io/pharmabot/")
PORT = int(os.environ.get("PORT", 8080))
WEBAPP_DIR = os.path.join(BASE_DIR, "webapp")

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

with open(os.path.join(DATA_DIR, "tests.json"), encoding="utf-8") as f:
    ALL_TESTS = json.load(f)

with open(os.path.join(DATA_DIR, "recipes.json"), encoding="utf-8") as f:
    ALL_RECIPES = json.load(f)

TESTS_BY_ID = {q["id"]: q for q in ALL_TESTS}
RECIPES_BY_ID = {r["id"]: r for r in ALL_RECIPES}

CHOICE_TESTS = [q for q in ALL_TESTS if q["type"] == "choice"]
FLASHCARD_TESTS = [q for q in ALL_TESTS if q["type"] != "choice"]

OPTION_LABELS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"]

BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def render_flashcard(raw: str, revealed: bool) -> str:
    """Turn the stored markdown-ish text into Telegram HTML.
    When not revealed, bolded (correct-answer) fragments are hidden."""
    parts = []
    last = 0
    for m in BOLD_RE.finditer(raw):
        parts.append(h(raw[last:m.start()]))
        if revealed:
            parts.append(f"<b>{h(m.group(1))}</b>")
        else:
            parts.append("<b>[ ? ]</b>")
        last = m.end()
    parts.append(h(raw[last:]))
    return "".join(parts)


def render_structured_body(q: dict, revealed: bool) -> str:
    """Render matching / table / characterize / fill_blank question types
    as clean HTML, without leaning on the original messy raw text."""
    qtype = q["type"]

    if qtype in ("matching", "table"):
        lines = [f"<b>{h(q['question'])}</b>", ""]
        for i, cat in enumerate(q["categories"]):
            lines.append(f"{i + 1}. {h(cat)}")
        lines.append("")
        for i, item in enumerate(q["items"]):
            if revealed:
                cat_idx = q["answer"][i]
                lines.append(f"• {h(item)} → <b>{cat_idx + 1}</b>. {h(q['categories'][cat_idx])}")
            else:
                lines.append(f"• {h(item)} → ?")
        return "\n".join(lines)

    if qtype == "characterize":
        lines = [f"<b>{h(q['question'])}</b>", ""]
        for axis in q["axes"]:
            lines.append(f"<u>{h(axis['label'])}</u>")
            for i, opt in enumerate(axis["options"]):
                mark = " ✅" if revealed and i == axis["correct"] else ""
                lines.append(f"  {i + 1}. {h(opt)}{mark}")
            lines.append("")
        return "\n".join(lines).strip()

    if qtype == "fill_blank" and "blanks" in q:
        lines = [f"<b>{h(q['question'])}</b>", ""]
        for bi, options in enumerate(q["blanks"]):
            lines.append(f"Пропуск {bi + 1}:")
            for opt in options:
                mark = " ✅" if revealed and opt["correct"] else ""
                lines.append(f"  · {h(opt['text'])}{mark}")
        return "\n".join(lines)

    # fallback: raw markdown-ish text with bold-hide/reveal
    return render_flashcard(q.get("raw", ""), revealed)


# ---------------------------------------------------------------------------
# Storage (SQLite) — per-user progress stats
# ---------------------------------------------------------------------------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS progress (
            user_id INTEGER,
            item_kind TEXT,   -- 'test' or 'recipe'
            item_id INTEGER,
            correct INTEGER,
            wrong INTEGER,
            PRIMARY KEY (user_id, item_kind, item_id)
        )"""
    )
    return conn


def record_result(user_id: int, kind: str, item_id: int, ok: bool):
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "SELECT correct, wrong FROM progress WHERE user_id=? AND item_kind=? AND item_id=?",
        (user_id, kind, item_id),
    )
    row = cur.fetchone()
    if row is None:
        c, w = (1, 0) if ok else (0, 1)
        cur.execute(
            "INSERT INTO progress (user_id, item_kind, item_id, correct, wrong) VALUES (?,?,?,?,?)",
            (user_id, kind, item_id, c, w),
        )
    else:
        c, w = row
        if ok:
            c += 1
        else:
            w += 1
        cur.execute(
            "UPDATE progress SET correct=?, wrong=? WHERE user_id=? AND item_kind=? AND item_id=?",
            (c, w, user_id, kind, item_id),
        )
    conn.commit()
    conn.close()


def get_stats(user_id: int):
    conn = db()
    cur = conn.cursor()
    stats = {}
    for kind in ("test", "recipe"):
        cur.execute(
            "SELECT COALESCE(SUM(correct),0), COALESCE(SUM(wrong),0), COUNT(*) FROM progress WHERE user_id=? AND item_kind=?",
            (user_id, kind),
        )
        c, w, n = cur.fetchone()
        stats[kind] = {"correct": c, "wrong": w, "items_seen": n}
    conn.close()
    return stats


def weakest_items(user_id: int, kind: str, pool_ids, limit=15):
    """Return item ids from pool that the user gets wrong most often (for focused practice)."""
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "SELECT item_id, wrong, correct FROM progress WHERE user_id=? AND item_kind=?",
        (user_id, kind),
    )
    rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    conn.close()
    scored = []
    for iid in pool_ids:
        wrong, correct = rows.get(iid, (0, 0))
        score = wrong - correct * 0.5
        scored.append((score, iid))
    scored.sort(reverse=True)
    return [iid for _, iid in scored[:limit]]


# ---------------------------------------------------------------------------
# In-memory session state per user (current training/exam queue)
# ---------------------------------------------------------------------------

@dataclass
class Session:
    mode: str = ""          # 'train_test' | 'exam_test' | 'train_recipe' | 'exam_recipe'
    queue: list = field(default_factory=list)   # list of item ids left to show
    pos: int = 0
    total: int = 0
    correct: int = 0
    wrong: int = 0
    selected: set = field(default_factory=set)  # for multi-choice toggle state
    revealed: bool = False

SESSIONS: dict[int, Session] = {}


def get_session(user_id: int) -> Session:
    if user_id not in SESSIONS:
        SESSIONS[user_id] = Session()
    return SESSIONS[user_id]


# ---------------------------------------------------------------------------
# Keyboards
# ---------------------------------------------------------------------------

def main_menu_kb() -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text="📝 Тесты — тренировка", callback_data="menu:train_test")],
        [InlineKeyboardButton(text="🎯 Тесты — экзамен", callback_data="menu:exam_test")],
        [InlineKeyboardButton(text="💊 Рецепты — тренировка", callback_data="menu:train_recipe")],
        [InlineKeyboardButton(text="📋 Рецепты — экзамен", callback_data="menu:exam_recipe")],
        [InlineKeyboardButton(text="📊 Статистика", callback_data="menu:stats")],
    ]
    return InlineKeyboardMarkup(inline_keyboard=rows)


def back_to_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="⬅️ В меню", callback_data="menu:root")]]
    )


def choice_kb(q, selected: set) -> InlineKeyboardMarkup:
    rows = []
    for i, opt in enumerate(q["options"]):
        label = OPTION_LABELS[i] if i < len(OPTION_LABELS) else str(i + 1)
        mark = "☑️ " if i in selected else ""
        rows.append([InlineKeyboardButton(text=f"{mark}{label}. {opt['text'][:60]}", callback_data=f"opt:{i}")])
    if q.get("multi"):
        rows.append([InlineKeyboardButton(text="✅ Готово", callback_data="opt:submit")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def flashcard_kb(revealed: bool) -> InlineKeyboardMarkup:
    if not revealed:
        return InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="👁 Показать ответ", callback_data="fc:reveal")]]
        )
    rows = [
        [
            InlineKeyboardButton(text="✅ Знал(а)", callback_data="fc:knew"),
            InlineKeyboardButton(text="❌ Не знал(а)", callback_data="fc:didnt"),
        ]
    ]
    return InlineKeyboardMarkup(inline_keyboard=rows)


def recipe_kb(revealed: bool) -> InlineKeyboardMarkup:
    return flashcard_kb(revealed)


def next_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="➡️ Далее", callback_data="go:next")]]
    )


# ---------------------------------------------------------------------------
# Router / handlers
# ---------------------------------------------------------------------------

router = Router()


@router.message(CommandStart())
async def cmd_start(message: Message):
    SESSIONS.pop(message.from_user.id, None)
    kb = InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="📖 Открыть тренажёр", web_app=WebAppInfo(url=MINIAPP_URL))]]
    )
    await message.answer(
        "Привет! Тесты и рецепты 1-го этапа экзамена — в удобном приложении.\n\n"
        "Команда /menu — классический режим прямо в чате.",
        reply_markup=kb,
    )


@router.message(Command("menu"))
async def cmd_menu(message: Message):
    await message.answer("Меню (классический режим в чате):", reply_markup=main_menu_kb())


@router.message(Command("stats"))
async def cmd_stats(message: Message):
    await send_stats(message.from_user.id, message)


async def send_stats(user_id: int, target):
    st = get_stats(user_id)
    t, r = st["test"], st["recipe"]

    def pct(c, w):
        tot = c + w
        return f"{round(100 * c / tot)}%" if tot else "—"

    text = (
        "📊 <b>Твоя статистика</b>\n\n"
        f"📝 Тесты: отвечено {t['correct'] + t['wrong']} раз "
        f"(верно {t['correct']}, неверно {t['wrong']}) — точность {pct(t['correct'], t['wrong'])}\n"
        f"Разобрано уникальных заданий: {t['items_seen']} из {len(ALL_TESTS)}\n\n"
        f"💊 Рецепты: отмечено {r['correct'] + r['wrong']} раз "
        f"(знал {r['correct']}, не знал {r['wrong']}) — точность {pct(r['correct'], r['wrong'])}\n"
        f"Разобрано уникальных рецептов: {r['items_seen']} из {len(ALL_RECIPES)}"
    )
    if isinstance(target, CallbackQuery):
        await target.message.edit_text(text, reply_markup=back_to_menu_kb(), parse_mode="HTML")
    else:
        await target.answer(text, reply_markup=back_to_menu_kb(), parse_mode="HTML")


@router.callback_query(F.data == "menu:root")
async def cb_menu_root(cb: CallbackQuery):
    SESSIONS.pop(cb.from_user.id, None)
    await cb.message.edit_text("Меню:", reply_markup=main_menu_kb())
    await cb.answer()


@router.callback_query(F.data == "menu:stats")
async def cb_stats(cb: CallbackQuery):
    await send_stats(cb.from_user.id, cb)
    await cb.answer()


# --- mode selection -------------------------------------------------------

@router.callback_query(F.data.startswith("menu:"))
async def cb_menu_select(cb: CallbackQuery):
    mode = cb.data.split(":", 1)[1]
    if mode in ("root", "stats"):
        return  # handled above
    user_id = cb.from_user.id
    sess = get_session(user_id)
    sess.mode = mode
    sess.pos = 0
    sess.correct = 0
    sess.wrong = 0
    sess.revealed = False
    sess.selected = set()

    if mode == "train_test":
        pool = [q["id"] for q in CHOICE_TESTS] + [q["id"] for q in FLASHCARD_TESTS]
        random.shuffle(pool)
        sess.queue = pool
        sess.total = len(pool)
        await cb.message.edit_text(
            "📝 <b>Тренировка тестов</b>\nВопросы идут в случайном порядке, все 159. "
            "Отвечай сколько хочешь — прогресс сохраняется.",
            parse_mode="HTML",
        )
        await show_next_test(cb.message, user_id)

    elif mode == "exam_test":
        n = min(EXAM_TEST_COUNT, len(ALL_TESTS))
        pool = random.sample([q["id"] for q in ALL_TESTS], n)
        sess.queue = pool
        sess.total = n
        await cb.message.edit_text(
            f"🎯 <b>Экзаменационный билет</b>\n{n} случайных заданий, как на реальном экзамене. Поехали!",
            parse_mode="HTML",
        )
        await show_next_test(cb.message, user_id)

    elif mode == "train_recipe":
        pool = [r["id"] for r in ALL_RECIPES]
        random.shuffle(pool)
        sess.queue = pool
        sess.total = len(pool)
        await cb.message.edit_text(
            "💊 <b>Тренировка рецептов</b>\nПоказываю препарат — вспоминаешь Rp. и жмёшь «Показать ответ».",
            parse_mode="HTML",
        )
        await show_next_recipe(cb.message, user_id)

    elif mode == "exam_recipe":
        n = min(EXAM_RECIPE_COUNT, len(ALL_RECIPES))
        pool = random.sample([r["id"] for r in ALL_RECIPES], n)
        sess.queue = pool
        sess.total = n
        await cb.message.edit_text(
            f"📋 <b>Билет по рецептам</b>\n{n} случайных препаратов.",
            parse_mode="HTML",
        )
        await show_next_recipe(cb.message, user_id)

    await cb.answer()


# --- test flow --------------------------------------------------------------

async def show_next_test(message: Message, user_id: int):
    sess = get_session(user_id)
    if sess.pos >= len(sess.queue):
        await finish_session(message, user_id, kind="test")
        return
    qid = sess.queue[sess.pos]
    q = TESTS_BY_ID[qid]
    sess.selected = set()
    sess.revealed = False

    header = f"[{sess.pos + 1}/{sess.total}]\n\n"
    if q["type"] == "choice":
        text = header + h(q["question"])
        await message.answer(text, reply_markup=choice_kb(q, set()))
    else:
        body = render_structured_body(q, revealed=False)
        kind_label = {
            "matching": "🔗 Соответствие",
            "fill_blank": "✏️ Вставьте слова",
            "table": "📊 Таблица",
            "characterize": "🧩 Охарактеризуйте",
            "flashcard": "❓ Задание",
        }.get(q["type"], "❓ Задание")
        text = header + f"<i>{kind_label}</i>\n\n" + body
        await message.answer(text, reply_markup=flashcard_kb(False), parse_mode="HTML")


@router.callback_query(F.data.startswith("opt:"))
async def cb_option(cb: CallbackQuery):
    user_id = cb.from_user.id
    sess = get_session(user_id)
    if not sess.queue or sess.pos >= len(sess.queue):
        await cb.answer()
        return
    qid = sess.queue[sess.pos]
    q = TESTS_BY_ID[qid]
    action = cb.data.split(":", 1)[1]

    if sess.revealed:
        await cb.answer()
        return

    if action == "submit":
        await grade_choice(cb, q, sess, user_id)
        return

    idx = int(action)
    if q.get("multi"):
        if idx in sess.selected:
            sess.selected.discard(idx)
        else:
            sess.selected.add(idx)
        await cb.message.edit_reply_markup(reply_markup=choice_kb(q, sess.selected))
        await cb.answer()
    else:
        sess.selected = {idx}
        await grade_choice(cb, q, sess, user_id)


async def grade_choice(cb: CallbackQuery, q, sess: Session, user_id: int):
    correct_idx = {i for i, o in enumerate(q["options"]) if o["correct"]}
    ok = sess.selected == correct_idx
    sess.revealed = True
    record_result(user_id, "test", q["id"], ok)
    if ok:
        sess.correct += 1
    else:
        sess.wrong += 1

    lines = []
    for i, opt in enumerate(q["options"]):
        label = OPTION_LABELS[i] if i < len(OPTION_LABELS) else str(i + 1)
        mark = "✅" if i in correct_idx else ("❌" if i in sess.selected else "▫️")
        lines.append(f"{mark} {label}. {h(opt['text'])}")
    verdict = "✅ Верно!" if ok else "❌ Неверно."
    text = cb.message.text or ""
    new_text = f"{h(text)}\n\n" + "\n".join(lines) + f"\n\n<b>{verdict}</b>"
    await cb.message.edit_text(new_text, reply_markup=next_kb(), parse_mode="HTML")
    await cb.answer()


@router.callback_query(F.data == "fc:reveal")
async def cb_reveal(cb: CallbackQuery):
    user_id = cb.from_user.id
    sess = get_session(user_id)
    if sess.mode in ("train_test", "exam_test"):
        qid = sess.queue[sess.pos]
        q = TESTS_BY_ID[qid]
        sess.revealed = True
        header = f"[{sess.pos + 1}/{sess.total}]\n\n"
        kind_label = {
            "matching": "🔗 Соответствие",
            "fill_blank": "✏️ Вставьте слова",
            "table": "📊 Таблица",
            "characterize": "🧩 Охарактеризуйте",
            "flashcard": "❓ Задание",
        }.get(q["type"], "❓ Задание")
        body = render_structured_body(q, revealed=True)
        text = header + f"<i>{kind_label}</i>\n\n" + body
        await cb.message.edit_text(text, reply_markup=flashcard_kb(True), parse_mode="HTML")
    else:
        rid = sess.queue[sess.pos]
        r = RECIPES_BY_ID[rid]
        sess.revealed = True
        header = f"[{sess.pos + 1}/{sess.total}]\n\n"
        text = header + f"💊 <b>{h(r['name'])}</b>\n\n<pre>{h(r['raw'])}</pre>"
        await cb.message.edit_text(text, reply_markup=recipe_kb(True), parse_mode="HTML")
    await cb.answer()


@router.callback_query(F.data.in_(["fc:knew", "fc:didnt"]))
async def cb_knew(cb: CallbackQuery):
    user_id = cb.from_user.id
    sess = get_session(user_id)
    ok = cb.data == "fc:knew"
    if sess.mode in ("train_test", "exam_test"):
        qid = sess.queue[sess.pos]
        record_result(user_id, "test", qid, ok)
    else:
        rid = sess.queue[sess.pos]
        record_result(user_id, "recipe", rid, ok)
    if ok:
        sess.correct += 1
    else:
        sess.wrong += 1
    sess.pos += 1
    if sess.mode in ("train_test", "exam_test"):
        await show_next_test(cb.message, user_id)
    else:
        await show_next_recipe(cb.message, user_id)
    await cb.answer()


@router.callback_query(F.data == "go:next")
async def cb_next(cb: CallbackQuery):
    user_id = cb.from_user.id
    sess = get_session(user_id)
    sess.pos += 1
    if sess.mode in ("train_test", "exam_test"):
        await show_next_test(cb.message, user_id)
    else:
        await show_next_recipe(cb.message, user_id)
    await cb.answer()


# --- recipe flow -------------------------------------------------------------

async def show_next_recipe(message: Message, user_id: int):
    sess = get_session(user_id)
    if sess.pos >= len(sess.queue):
        await finish_session(message, user_id, kind="recipe")
        return
    rid = sess.queue[sess.pos]
    r = RECIPES_BY_ID[rid]
    sess.revealed = False
    header = f"[{sess.pos + 1}/{sess.total}]\n\n"
    text = header + f"💊 Напиши рецепт на препарат:\n\n<b>{h(r['name'])}</b>"
    await message.answer(text, reply_markup=flashcard_kb(False), parse_mode="HTML")


async def finish_session(message: Message, user_id: int, kind: str):
    sess = get_session(user_id)
    total = sess.correct + sess.wrong
    pct = round(100 * sess.correct / total) if total else 0
    label = "тестов" if kind == "test" else "рецептов"
    text = (
        f"🏁 <b>Готово!</b>\n\n"
        f"Пройдено {label}: {total}\n"
        f"Верно: {sess.correct} | Неверно: {sess.wrong}\n"
        f"Точность: {pct}%"
    )
    SESSIONS.pop(user_id, None)
    await message.answer(text, reply_markup=main_menu_kb(), parse_mode="HTML")


# ---------------------------------------------------------------------------
# Web app (Telegram Mini App): static frontend + JSON API
# ---------------------------------------------------------------------------

def validate_init_data(init_data: str):
    """Validate Telegram WebApp initData per Telegram's documented algorithm.
    Returns the parsed user dict on success, or None if invalid/missing."""
    if not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, received_hash):
        return None
    user_raw = pairs.get("user")
    if not user_raw:
        return None
    try:
        return json.loads(user_raw)
    except json.JSONDecodeError:
        return None


async def handle_index(request: web.Request):
    return web.FileResponse(os.path.join(WEBAPP_DIR, "index.html"))


async def handle_api_data(request: web.Request):
    return web.json_response({"tests": ALL_TESTS, "recipes": ALL_RECIPES})


def _user_id_from_request(payload: dict):
    user = validate_init_data(payload.get("initData", ""))
    if not user:
        return None
    return user.get("id")


async def handle_api_progress(request: web.Request):
    payload = await request.json()
    user_id = _user_id_from_request(payload)
    if user_id is None:
        return web.json_response({"error": "invalid initData"}, status=401)
    kind = payload.get("kind")
    item_id = payload.get("item_id")
    ok = bool(payload.get("correct"))
    if kind not in ("test", "recipe") or not isinstance(item_id, int):
        return web.json_response({"error": "bad request"}, status=400)
    record_result(user_id, kind, item_id, ok)
    return web.json_response({"status": "ok"})


async def handle_api_stats(request: web.Request):
    payload = await request.json() if request.can_read_body else {}
    user_id = _user_id_from_request(payload)
    if user_id is None:
        return web.json_response({"error": "invalid initData"}, status=401)
    return web.json_response(get_stats(user_id))


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/api/data", handle_api_data)
    app.router.add_post("/api/progress", handle_api_progress)
    app.router.add_post("/api/stats", handle_api_stats)
    return app


# ---------------------------------------------------------------------------

async def main():
    bot = Bot(token=TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    log.info("Bot starting. Loaded %d tests, %d recipes.", len(ALL_TESTS), len(ALL_RECIPES))

    if WEBAPP_URL:
        app = build_web_app()
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", PORT)
        await site.start()
        log.info("Web app server listening on 0.0.0.0:%d (public URL: %s)", PORT, WEBAPP_URL)

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
