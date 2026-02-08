require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  KAKAO_REST_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  PORT = 3000,
} = process.env;

// ─── 카카오 도서 검색 ───────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const { query, page = 1 } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    const url = new URL("https://dapi.kakao.com/v3/search/book");
    url.searchParams.set("query", query);
    url.searchParams.set("size", "10");
    url.searchParams.set("page", page);

    const response = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    const books = data.documents.map((doc) => ({
      title: doc.title,
      authors: doc.authors,
      publisher: doc.publisher,
      thumbnail: doc.thumbnail,
      isbn: doc.isbn,
      datetime: doc.datetime,
      url: doc.url,
      contents: doc.contents,
      price: doc.price,
      sale_price: doc.sale_price,
    }));

    res.json({
      books,
      meta: data.meta,
    });
  } catch (err) {
    console.error("카카오 API 에러:", err);
    res.status(500).json({ error: "도서 검색 중 오류가 발생했습니다" });
  }
});

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
app.post("/api/add-to-notion", async (req, res) => {
  const { title, authors, thumbnail, publisher, isbn, url: bookUrl, datetime } = req.body;

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

    // 저자 속성 찾기 - "저자", "작가", "Author" 등
    const authorKeys = ["저자", "작가", "Author", "author", "Authors", "authors"];
    const authorProp = Object.entries(schema).find(
      ([key]) => authorKeys.includes(key)
    );
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
        properties[isbnProp[0]] = { number: parseInt(isbn.split(" ").pop(), 10) };
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
    if (dateProp && datetime) {
      properties[dateProp[0]] = {
        date: { start: datetime.split("T")[0] },
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
