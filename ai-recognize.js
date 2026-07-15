/* =========================================================================
   ai-recognize.js — распознавание товарных позиций через Claude API.

   Подключается ПОСЛЕ app.js. Перехватывает readFileItems: сначала пробует
   ИИ (через прокси /api/anthropic), при недоступности API откатывается на
   штатный локальный парсер. Возвращает позиции в том же формате, что и
   app.js, поэтому вся дальнейшая обработка (объединение, распределение
   брутто, сверка, выгрузка XLSX) работает без изменений.
   ========================================================================= */
"use strict";

(function () {
  /* Модель задаётся на сервере (ANTHROPIC_MODEL); клиент её не навязывает. */
  const MAX_PDF_PAGES = 6;      // ограничение страниц для сканов (стоимость/размер)
  const RENDER_SCALE = 2;       // масштаб рендера страницы скана в картинку

  const SYSTEM_PROMPT =
    "Ты — парсер коммерческих документов ВЭД (инвойсы, упаковочные листы, " +
    "спецификации) на русском, английском и китайском. Извлекаешь только " +
    "реальные товарные позиции. Отвечаешь ТОЛЬКО валидным JSON-массивом — " +
    "без markdown-обёрток, без пояснений, без текста до или после.";

  const SCHEMA_INSTRUCTION = `Извлеки все товарные позиции документа в JSON-массив. Каждый элемент:
{
  "name": "наименование товара (строка)",
  "article": "артикул / код изделия / модель, или пустая строка",
  "unitRaw": "единица измерения как в документе (шт, pcs, кг, компл, pair...), или пустая строка",
  "qty": число или null,        // количество
  "price": число или null,      // цена за единицу
  "total": число или null,      // общая стоимость строки
  "netUnit": число или null,    // вес нетто за единицу, кг
  "netTotal": число или null,   // вес нетто общий по строке, кг
  "gross": число или null,      // вес брутто, кг
  "place": "№ грузового места, или пустая строка"
}

Правила:
- Только товарные строки. Пропускай «Итого/Всего/Total/Grand total», реквизиты, банковские данные, адреса, подписи, габариты, служебные строки.
- Числа возвращай числами (десятичный разделитель — точка), а не строками. Если значения в документе нет — null. Ничего не выдумывай.
- unitRaw — ровно как в документе, без нормализации в коды.
- Если один товар лежит в нескольких грузовых местах — сделай отдельный элемент на каждое место со своим "place" и своими весами.
- Наименование бери максимально полное. Не объединяй разные товары в одну строку.

Верни только JSON-массив (может быть пустым []).`;

  /* ---------- Извлечение содержимого документа ---------------------------- */

  async function pdfText(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map((i) => i.str).join(" ") + "\n";
    }
    return text;
  }

  async function pdfToImages(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const images = [];
    const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL("image/png").split(",")[1]);
    }
    return { images, truncated: pdf.numPages > n, total: pdf.numPages };
  }

  async function getDocContent(file) {
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "xlsx" || ext === "xls" || ext === "csv") {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      let text = "";
      for (const name of wb.SheetNames) {
        text += `# Лист: ${name}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]) + "\n\n";
      }
      return { type: "text", text };
    }

    if (ext === "docx") {
      const buf = await file.arrayBuffer();
      const res = await mammoth.extractRawText({ arrayBuffer: buf });
      return { type: "text", text: res.value };
    }

    if (ext === "txt") {
      return { type: "text", text: await file.text() };
    }

    if (ext === "pdf") {
      const t = await pdfText(file);
      /* Есть текстовый слой — работаем по тексту; иначе это скан → картинки. */
      if (t.replace(/\s/g, "").length > 40) return { type: "text", text: t };
      const { images, truncated, total } = await pdfToImages(file);
      if (truncated && typeof state !== "undefined" && Array.isArray(state.notes)) {
        state.notes.push(
          `«${file.name}»: скан на ${total} стр., распознаны первые ${MAX_PDF_PAGES}. ` +
          `Остальные пропущены (ограничение по стоимости запроса).`);
      }
      return { type: "images", images };
    }

    return { type: "text", text: await file.text() };
  }

  /* ---------- Вызов Claude через прокси ----------------------------------- */

  async function callClaude(userContent) {
    const res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: SYSTEM_PROMPT,
        max_tokens: 8000,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "HTTP " + res.status);
    return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  }

  function parseJsonLoose(text) {
    let t = String(text).trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  /* ---------- Приведение к формату позиций app.js ------------------------- */

  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : null;
  };
  const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

  function toItem(o, source) {
    return {
      source,
      name: str(o.name),
      article: str(o.article),
      unitRaw: str(o.unitRaw),
      qty: num(o.qty),
      price: num(o.price),
      total: num(o.total),
      netUnit: num(o.netUnit),
      netTotal: num(o.netTotal),
      gross: num(o.gross),
      place: str(o.place),
      mathErrors: [],   // математическую сверку downstream не ломает пустой массив
    };
  }

  async function aiExtract(file) {
    const content = await getDocContent(file);
    let userContent;
    if (content.type === "images") {
      userContent = content.images.map((b64) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      }));
      userContent.push({ type: "text", text: SCHEMA_INSTRUCTION });
    } else {
      userContent = [{
        type: "text",
        text: SCHEMA_INSTRUCTION + "\n\n=== ДОКУМЕНТ ===\n" + content.text,
      }];
    }
    const answer = await callClaude(userContent);
    const arr = parseJsonLoose(answer);
    if (!Array.isArray(arr)) throw new Error("ИИ вернул не JSON-массив");
    return arr.map((o) => toItem(o, file.name)).filter((it) => it.name || it.article);
  }

  /* ---------- Перехват readFileItems: ИИ → фолбэк на локальный парсер ------ */

  if (typeof window.readFileItems !== "function") {
    console.warn("ai-recognize: readFileItems не найден — модуль не активирован.");
    return;
  }
  const localReader = window.readFileItems;

  window.readFileItems = async function (file) {
    try {
      if (typeof setStatus === "function") setStatus(`ИИ распознаёт: ${file.name}…`);
      return await aiExtract(file);
    } catch (err) {
      if (typeof state !== "undefined" && Array.isArray(state.notes)) {
        state.notes.push(
          `ИИ недоступен для «${file.name}» (${err.message}) — обработано локальным парсером.`);
      }
      return localReader(file);
    }
  };

  console.log("ai-recognize: ИИ-распознавание активно (фолбэк на локальный парсер).");
})();
