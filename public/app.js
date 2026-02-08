const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const resultsEl = document.getElementById("results");
const toastEl = document.getElementById("toast");

let toastTimer = null;

function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (isError ? " error" : "");
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 3000);
}

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
searchBtn.addEventListener("click", doSearch);

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  resultsEl.innerHTML = '<div class="empty-state"><span class="spinner"></span> 검색 중...</div>';

  try {
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!res.ok) {
      resultsEl.innerHTML = `<div class="empty-state">오류: ${data.error}</div>`;
      return;
    }

    if (!data.books.length) {
      resultsEl.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
      return;
    }

    renderBooks(data.books);
  } catch (err) {
    resultsEl.innerHTML = `<div class="empty-state">네트워크 오류가 발생했습니다</div>`;
  }
}

function renderBooks(books) {
  resultsEl.innerHTML = "";
  books.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-card";

    const thumbHtml = book.thumbnail
      ? `<img class="book-thumb" src="${book.thumbnail}" alt="">`
      : `<div class="book-thumb no-img">No Image</div>`;

    const authorsStr = book.authors?.join(", ") || "저자 미상";
    const metaParts = [book.publisher, book.publishedDate].filter(Boolean).join(" · ");

    card.innerHTML = `
      ${thumbHtml}
      <div class="book-info">
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-authors">${escapeHtml(authorsStr)}</div>
        <div class="book-meta">${escapeHtml(metaParts)}</div>
      </div>
      <div class="book-action">
        <button class="add-btn">Notion에 추가</button>
      </div>
    `;

    const btn = card.querySelector(".add-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      addToNotion(book, card, btn);
    });

    resultsEl.appendChild(card);
  });
}

async function addToNotion(book, card, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  card.classList.add("adding");

  try {
    const res = await fetch("/api/add-to-notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(book),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(`실패: ${data.error}`, true);
      btn.textContent = "Notion에 추가";
      btn.disabled = false;
      card.classList.remove("adding");
      return;
    }

    btn.textContent = "추가 완료";
    btn.className = "add-btn done";
    card.classList.remove("adding");
    card.classList.add("added");
    showToast(`"${book.title}" Notion에 추가 완료`);
  } catch (err) {
    showToast("네트워크 오류", true);
    btn.textContent = "Notion에 추가";
    btn.disabled = false;
    card.classList.remove("adding");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
