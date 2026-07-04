import { Telegraf, Markup, Input } from "telegraf";
import { JSONFilePreset } from "lowdb/node";
import { searchTracks, downloadTrackStream } from "./sc-service.js";

const bot = new Telegraf("8948208535:AAEZZySaBHqt7LFCsoQtr5Jg6rymjpbtK1M");

const db = await JSONFilePreset("db.json", { users: {} });

async function updateDatabase(ctx) {
  const userId = ctx.from.id.toString();
  await db.update(({ users }) => {
    if (!users[userId]) {
      users[userId] = {
        id: userId,
        active: true,
      };
    } else {
      users[userId].active = true;
    }
  });
}

async function handleForbidden(userId) {
  await db.update(({ users }) => {
    if (users[userId]) users[userId].active = false;
  });
}

const sessions = new Map();
const floodCache = new Map();

const FLOOD_LIMIT = 2;
const FLOOD_WINDOW = 5000;
const BAN_DURATION = 5000;

const COOLDOWNS = {
  SEARCH: 15000,
  NAVIGATE: 2000,
  DOWNLOAD: 30000,
};

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return next();
  await updateDatabase(ctx);

  if (!ctx.message || !ctx.message.text) return next();

  const userId = ctx.from.id;
  const now = Date.now();

  let userFlood = floodCache.get(userId);
  if (!userFlood) {
    userFlood = { history: [], bannedUntil: 0 };
    floodCache.set(userId, userFlood);
  }

  if (userFlood.bannedUntil && now < userFlood.bannedUntil) {
    userFlood.bannedUntil = now + BAN_DURATION;
    console.log(`[Antiflood] Спам в бане от ${userId}. Бан продлен.`);
    return;
  }

  userFlood.history = userFlood.history.filter(
    (time) => now - time < FLOOD_WINDOW,
  );

  if (userFlood.history.length >= FLOOD_LIMIT) {
    userFlood.bannedUntil = now + BAN_DURATION;
    console.log(
      `[⚠️ ANTIFLOOD] ПОЛЬЗОВАТЕЛЬ ${userId} ЗАБАНЕН НА ${BAN_DURATION / 1000} СЕКУНД!`,
    );
    return;
  }
  userFlood.history.push(now);
  return next();
});

function checkCooldown(session, actionType) {
  if (!session) return { isLimited: false };
  if (!session.cooldowns) session.cooldowns = {};
  const now = Date.now();
  const lastTime = session.cooldowns[actionType] || 0;
  const cooldownTime = COOLDOWNS[actionType] || 2000;
  if (now - lastTime < cooldownTime) {
    const timeLeft = ((cooldownTime - (now - lastTime)) / 1000).toFixed(1);
    return { isLimited: true, timeLeft };
  }
  session.cooldowns[actionType] = now;
  return { isLimited: false };
}

function renderSearchPage(session) {
  let text = `🔍 Результаты: «${session.currentQuery}»\n\n`;
  session.tracks.forEach(
    (t, i) => (text += `${i + 1}. ${t.artist} — ${t.title} (${t.duration})\n`),
  );
  const buttons = session.tracks.map((_, i) =>
    Markup.button.callback(`${i + 1}`, `dl_${i}`),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5)
    rows.push(buttons.slice(i, i + 5));
  const nav = [
    Markup.button.callback("⬅️", "nav_prev"),
    Markup.button.callback(`Страница: ${session.currentPage + 1}`, "none"),
    Markup.button.callback("➡️", "nav_next"),
  ];
  return { text, keyboard: Markup.inlineKeyboard([...rows, nav]) };
}

bot.start(async (ctx) => {
  try {
    await ctx.replyWithPhoto(Input.fromLocalFile("./assets/hello.png"), {
      caption: "Введи название трека, чтобы начать поиск.",
      parse_mode: "Markdown",
    });
  } catch (e) {
    if (e.response?.error_code === 403) await handleForbidden(ctx.from.id);
    console.error("Ошибка в bot.start:", e.message);
  }
});

async function sendError(ctx, text) {
  try {
    await ctx.replyWithPhoto(Input.fromLocalFile("./assets/error.png"), {
      caption: text,
      parse_mode: "Markdown",
    });
  } catch (e) {
    if (e.response?.error_code === 403) await handleForbidden(ctx.from.id);
    console.error("Ошибка в sendError:", e.message);
  }
}

bot.on("text", async (ctx) => {
  try {
    let session = sessions.get(ctx.from.id) || { cooldowns: {} };
    const cooldown = checkCooldown(session, "SEARCH");
    if (cooldown.isLimited) {
      const reply = await ctx.reply(
        `⏳ Подождите еще ${cooldown.timeLeft} сек.`,
      );
      setTimeout(
        () => ctx.deleteMessage(reply.message_id).catch(() => {}),
        3000,
      );
      return;
    }

    const tracks = await searchTracks(ctx.message.text, 10, 0);
    if (!tracks.length) return sendError(ctx, "Ничего не найдено.");

    const sentMsg = await ctx.reply("⏳ Поиск...");
    session = {
      currentQuery: ctx.message.text,
      currentPage: 0,
      tracks,
      lastMessageId: null,
      cooldowns: session.cooldowns,
    };

    const { text, keyboard } = renderSearchPage(session);
    const finalMsg = await ctx.replyWithPhoto(
      Input.fromLocalFile("./assets/track-list.png"),
      { caption: text, ...keyboard },
    );

    session.lastMessageId = finalMsg.message_id;
    sessions.set(ctx.from.id, session);
    await ctx.telegram
      .deleteMessage(ctx.from.id, sentMsg.message_id)
      .catch(() => {});
  } catch (e) {
    if (e.response?.error_code === 403) await handleForbidden(ctx.from.id);
    console.error("Ошибка в обработчике текста:", e.message);
  }
});

bot.action(/.+/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const session = sessions.get(ctx.from.id);
    const userFlood = floodCache.get(ctx.from.id);

    if (
      !session ||
      ctx.callbackQuery.message.message_id !== session.lastMessageId
    ) {
      return await ctx
        .answerCbQuery(
          "❌ Эти кнопки неактуальны. Используйте меню в последнем сообщении.",
          { show_alert: true },
        )
        .catch(() => {});
    }

    if (
      userFlood &&
      userFlood.bannedUntil &&
      Date.now() < userFlood.bannedUntil
    ) {
      return await ctx
        .answerCbQuery("⚠️ Доступ заблокирован за спам текстом!", {
          show_alert: true,
        })
        .catch(() => {});
    }

    if (data === "none") {
      return await ctx.answerCbQuery().catch(() => {});
    }

    if (data.startsWith("dl_")) {
      const cooldown = checkCooldown(session, "DOWNLOAD");

      if (cooldown.isLimited) {
        return await ctx
          .answerCbQuery(
            `⚠️ Нельзя скачивать так часто! Ждите ${cooldown.timeLeft} сек.`,
            { show_alert: false },
          )
          .catch(() => {});
      }

      const index = parseInt(data.split("_")[1]);
      const track = session.tracks[index];
      await ctx.answerCbQuery().catch(() => {});
      const status = await ctx
        .reply(`⏳ Скачиваю: ${track.artist} - ${track.title}...`)
        .catch(() => null);

      try {
        const stream = await downloadTrackStream(track.permalink_url);
        await ctx.replyWithAudio(
          { source: stream },
          {
            title: track.title,
            performer: track.artist,
            caption: "📁 Трек скачан при помощи @FastSaverMusicBot",
            parse_mode: "Markdown",
          },
        );
        if (status) await ctx.deleteMessage(status.message_id).catch(() => {});
      } catch (e) {
        if (status) await ctx.deleteMessage(status.message_id).catch(() => {});
        await sendError(ctx, `${e.message}`).catch(() => {});
      }
      return;
    }
    if (data.startsWith("nav_")) {
      const cooldown = checkCooldown(session, "NAVIGATE");
      if (cooldown.isLimited) {
        return await ctx
          .answerCbQuery(`⚠️ Не спешите, ждите ${cooldown.timeLeft} сек.`, {
            show_alert: false,
          })
          .catch(() => {});
      }
      if (data === "nav_next") session.currentPage++;
      else if (session.currentPage > 0) session.currentPage--;
      else
        return await ctx.answerCbQuery("Это первая страница").catch(() => {});

      const newTracks = await searchTracks(
        session.currentQuery,
        10,
        session.currentPage * 10,
      );

      if (!newTracks.length) {
        session.currentPage--;
        return await ctx.answerCbQuery("Больше треков нет").catch(() => {});
      }

      session.tracks = newTracks;

      const { text, keyboard } = renderSearchPage(session);

      await ctx
        .editMessageCaption(text, {
          reply_markup: keyboard.reply_markup,
        })
        .catch(() => {});

      await ctx.answerCbQuery().catch(() => {});

      return;
    }
  } catch (error) {
    console.error("Ошибка в bot.action:", error.message);

    await ctx.answerCbQuery("Произошла внутренняя ошибка").catch(() => {});
  }
});

bot.catch((err, ctx) => {
  console.error(
    `[Telegraf Глобальная Ошибка] Сбой при обработке update ${ctx.update.update_id}:`,
    err,
  );
});

bot.launch().then(() => console.log("Бот запущен!"));

console.log("Бот запущен!");
