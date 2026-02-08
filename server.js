require("dotenv").config();
const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  PORT = 3000,
} = process.env;

const YES24_BASE = "https://www.yes24.com";

// ─── Yes24 도서 검색 ────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    // 1단계: 검색 결과 페이지에서 상품 ID 목록 추출
    const searchUrl = `${YES24_BASE}/Product/Search?domain=ALL&query=${encodeURIComponent(query)}&page=1&size=8`;
    const searchRes = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
    const searchHtml = await searchRes.text();
    const $search = cheerio.load(searchHtml);

    const goodsIds = [];
    $search("li[data-goods-no]").each((_, el) => {
      goodsIds.push($search(el).attr("data-goods-no"));
    });

    if (!goodsIds.length) {
      return res.json({ books: [] });
    }

    // 2단계: 각 상품 페이지에서 상세 정보 파싱 (병렬 처리)
    const books = await Promise.all(
      goodsIds.map((goodsNo) => parseProductPage(goodsNo))
    );

    res.json({ books: books.filter(Boolean) });
  } catch (err) {
    console.error("Yes24 검색 에러:", err);
    res.status(500).json({ error: "도서 검색 중 오류가 발생했습니다" });
  }
});

async function parseProductPage(goodsNo) {
  try {
    const url = `${YES24_BASE}/Product/Goods/${goodsNo}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
    const html = await res.text();
    const $ = cheerio.load(html);

    // 제목
    const title = $("h2.gd_name").text().trim();
    if (!title) return null;

    // 저자
    const authorsEl = $("span.gd_auth");
    let authors = [];
    if (authorsEl.length) {
      const moreAuth = authorsEl.find("span.moreAuthLi");
      if (moreAuth.length) {
        moreAuth.find("a").each((_, a) => authors.push($(a).text().trim()));
      } else {
        authorsEl.find("> a").each((_, a) => authors.push($(a).text().trim()));
      }
    }

    // 출판사
    const publisher = $("span.gd_pub").text().trim();

    // 출간일
    let publishedDate = $("span.gd_date").text().trim();
    const dateMatch = publishedDate.match(/(\d{4})년\s*(\d{2})월\s*(\d{2})일/);
    if (dateMatch) {
      publishedDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }

    // ISBN13
    let isbn = "";
    $("th").each((_, th) => {
      if ($(th).text().trim() === "ISBN13") {
        isbn = $(th).next("td").text().trim();
      }
    });

    // 표지 이미지 — URL 패턴으로 직접 생성
    const thumbnail = `https://image.yes24.com/goods/${goodsNo}/XL`;

    // 평점
    let rating = 0;
    const ratingEl = $("span.gd_rating em");
    if (ratingEl.length) {
      const raw = parseFloat(ratingEl.text().trim());
      if (!isNaN(raw)) rating = Math.min(5, Math.max(0, Math.round(raw / 2)));
    }

    // 설명
    const description = $("div.infoWrap_txtInner").text().trim();

    return {
      title,
      authors,
      publisher,
      publishedDate,
      isbn,
      thumbnail,
      rating,
      description,
      url: url,
      goodsNo,
    };
  } catch (err) {
    console.error(`상품 ${goodsNo} 파싱 실패:`, err.message);
    return null;
  }
}

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
app.post("/api/add-to-notion", async (req, res) => {
  const { title, authors, thumbnail, publisher, isbn, url: bookUrl, publishedDate } = req.body;

  if (!title) return res.status(400).json({ error: "title은 필수입니다" });

  try {
    // Notion 데이터베이스 스키마를 먼저 조회하여 속성 이름 매핑
    const dbRes = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );

    if (!dbRes.ok) {
      const text = await dbRes.text();
      return res.status(dbRes.status).json({ error: `Notion DB 조회 실패: ${text}` });
    }

    const dbData = await dbRes.json();
    const schema = dbData.properties;

    // 속성 타입별로 매핑 탐색
    const properties = {};

    // 제목 속성 찾기 (title 타입)
    const titleProp = Object.entries(schema).find(([, v]) => v.type === "title");
    if (titleProp) {
      properties[titleProp[0]] = {
        title: [{ text: { content: title } }],
      };
    }

    // 저자 속성 찾기
    const authorKeys = ["저자", "작가", "Author", "author", "Authors", "authors"];
    const authorProp = Object.entries(schema).find(([key]) => authorKeys.includes(key));
    if (authorProp && authors?.length) {
      const authorStr = authors.join(", ");
      if (authorProp[1].type === "rich_text") {
        properties[authorProp[0]] = {
          rich_text: [{ text: { content: authorStr } }],
        };
      } else if (authorProp[1].type === "multi_select") {
        properties[authorProp[0]] = {
          multi_select: authors.map((a) => ({ name: a })),
        };
      }
    }

    // 출판사 속성 찾기
    const pubKeys = ["출판사", "Publisher", "publisher"];
    const pubProp = Object.entries(schema).find(([key]) => pubKeys.includes(key));
    if (pubProp && publisher) {
      if (pubProp[1].type === "rich_text") {
        properties[pubProp[0]] = {
          rich_text: [{ text: { content: publisher } }],
        };
      } else if (pubProp[1].type === "select") {
        properties[pubProp[0]] = { select: { name: publisher } };
      }
    }

    // ISBN 속성 찾기
    const isbnKeys = ["ISBN", "isbn"];
    const isbnProp = Object.entries(schema).find(([key]) => isbnKeys.includes(key));
    if (isbnProp && isbn) {
      if (isbnProp[1].type === "rich_text") {
        properties[isbnProp[0]] = {
          rich_text: [{ text: { content: isbn } }],
        };
      } else if (isbnProp[1].type === "number") {
        properties[isbnProp[0]] = { number: parseInt(isbn, 10) };
      }
    }

    // URL 속성 찾기
    const urlKeys = ["URL", "url", "링크", "Link", "link"];
    const urlProp = Object.entries(schema).find(([key]) => urlKeys.includes(key));
    if (urlProp && bookUrl) {
      properties[urlProp[0]] = { url: bookUrl };
    }

    // 날짜 속성 찾기
    const dateKeys = ["출간일", "출판일", "Date", "date", "날짜"];
    const dateProp = Object.entries(schema).find(([key]) => dateKeys.includes(key));
    if (dateProp && publishedDate) {
      properties[dateProp[0]] = {
        date: { start: publishedDate },
      };
    }

    // 유형/카테고리 속성에 "책" 자동 설정
    const typeKeys = ["유형", "타입", "Type", "type", "카테고리", "Category"];
    const typeProp = Object.entries(schema).find(([key]) => typeKeys.includes(key));
    if (typeProp) {
      if (typeProp[1].type === "select") {
        properties[typeProp[0]] = { select: { name: "책" } };
      } else if (typeProp[1].type === "multi_select") {
        properties[typeProp[0]] = { multi_select: [{ name: "책" }] };
      }
    }

    // Notion 페이지 생성
    const body = {
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    };

    // 표지 이미지가 있으면 커버로 설정
    if (thumbnail) {
      body.cover = {
        type: "external",
        external: { url: thumbnail },
      };
      body.icon = {
        type: "external",
        external: { url: thumbnail },
      };
    }

    const createRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      return res.status(createRes.status).json({ error: `Notion 페이지 생성 실패: ${text}` });
    }

    const page = await createRes.json();
    res.json({ success: true, pageId: page.id, url: page.url });
  } catch (err) {
    console.error("Notion API 에러:", err);
    res.status(500).json({ error: "Notion 페이지 생성 중 오류가 발생했습니다" });
  }
});

// ─── Notion DB 스키마 조회 (디버깅용) ───────────────────────
app.get("/api/notion-schema", async (req, res) => {
  try {
    const dbRes = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );
    const data = await dbRes.json();
    const schema = Object.entries(data.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
    }));
    res.json({ title: data.title?.[0]?.plain_text, schema });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
