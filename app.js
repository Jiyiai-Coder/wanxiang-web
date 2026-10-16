/* 万象幻境 · 前端逻辑（v2：建档向导 + 自动保存 + 世界记忆隔离） */
const $ = (s) => document.querySelector(s);
const logEl = $("#log");
const scrollEl = $("#logwrap"); // 真正的滚动容器
let busy = false;
let rendered = [];
let renderedMsgs = [];
let lastAiEl = null;
let pendingEl = null;
let state = null;
let wizardMode = "create"; // create | edit
let wxCode = localStorage.getItem("wx_code") || ""; // 手机远程访问码

/* ================= 基础 ================= */

function deviceId() {
  let id = localStorage.getItem("wx_device_id");
  if (!id) {
    id = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("wx_device_id", id);
  }
  return id;
}

async function call(payload) {
  const r = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WX-Code": wxCode, "X-WX-Device": deviceId() },
    body: JSON.stringify(payload || {}),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const s = await r.json();
  if (s && s.error === "need_code") {
    try { bootHide(); } catch (e) {}
    showPinOverlay();
  }
  return s;
}

function setBusy(b) {
  document.querySelectorAll("button").forEach((x) => (x.disabled = b));
  $("#textin").disabled = b;
}

/* ================= 本机存档（进度保存在本浏览器，云端重置也不丢） ================= */
let wxLocalRestored = false;
let wxDumpTimer = null;
function wxLocalSave() {
  try { return JSON.parse(localStorage.getItem("wx_local_save") || "null"); }
  catch (e) { return null; }
}
function wxLocalStore(blob) {
  try {
    localStorage.setItem("wx_local_save", JSON.stringify(blob));
    const b = document.getElementById("wx-local-badge");
    if (b) b.textContent = "💾 已存本机 " + new Date().toTimeString().slice(0, 5);
  } catch (e) {}
}
function wxLocalBadge() {
  if (document.getElementById("wx-local-badge")) return;
  const d = document.createElement("div");
  d.id = "wx-local-badge";
  d.style.cssText = "position:fixed;right:14px;bottom:70px;z-index:80;background:rgba(255,253,246,.93);border:1px solid #e0c89a;color:#8a6a3a;font-size:11px;font-weight:700;padding:4px 10px;border-radius:14px;pointer-events:none";
  d.textContent = wxLocalSave() ? "💾 已存本机" : "💾 本机存档开启";
  document.body.appendChild(d);
}
function wxScheduleDump() {
  if (wxDumpTimer) return;
  wxDumpTimer = setTimeout(() => {
    wxDumpTimer = null;
    call({ action: "dump_all" }).then((s) => {
      if (s && s.assist && s.assist.worlds) wxLocalStore(s.assist);
    }).catch(() => {});
  }, 3000);
}
function wxMaybeRestore(s) {
  if (wxLocalRestored) return;
  wxLocalRestored = true;
  const blob = wxLocalSave();
  if (!blob || !blob.worlds || !Object.keys(blob.worlds).length) return;
  if (s.mode === "worlds" && (!s.worlds || !s.worlds.length)) {
    call({ action: "restore_all", data: blob }).then((s2) => {
      if (s2 && s2.assist && s2.assist.ok) applyState(s2);
    }).catch(() => {});
  }
}

function showTyping(b) {
  $("#typing").classList.toggle("hidden", !b);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function post(payload, opts) {
  if (busy) return Promise.resolve();
  busy = true;
  setBusy(true);
  if (payload.action === "say") {
    pendingEl = addMeBubble(payload.text);
    showTyping(true);
  } else if (["start", "regenerate"].includes(payload.action)) {
    showTyping(true);
  }
  return call(payload)
    .then((s) => {
      removePending();
      applyState(s);
    })
    .catch((e) => {
      removePending();
      addSys("⚠ " + e.message);
    })
    .finally(() => {
      busy = false;
      setBusy(false);
      showTyping(false);
    });
}

function wizardNote(text) {
  const fb = $("#wizard-feedback");
  const el = document.createElement("div");
  el.className = "wiz-note";
  el.textContent = text;
  fb.appendChild(el);
  while (fb.children.length > 5) fb.removeChild(fb.firstChild);
}

function appendField(field, text) {
  const map = {
    world: "#f-world", protagonist: "#f-protagonist", characters: "#f-characters",
    style: "#f-style", rules: "#f-rules", desc: "#f-desc",
  };
  if (!map[field]) return;
  const el = $(map[field]);
  const cur = el.value.replace(/\s+$/, "");
  el.value = cur ? cur + "\n" + text : text;
}

function postAssist(field, btn) {
  if (busy) return;
  busy = true;
  setBusy(true);
  const orig = btn.textContent;
  btn.textContent = "💭 AI 续写中……";
  call({ action: "ai_assist", field, draft: collectDraft() })
    .then((s) => {
      state = s;
      if (s.assist) {
        if (s.assist.field === "all" && s.assist.profile) {
          // 只补空字段：已填内容一字不动
          const draft = collectDraft();
          const merged = {};
          Object.keys(s.assist.profile).forEach((k) => {
            merged[k] = draft[k] && draft[k].trim() ? draft[k] : s.assist.profile[k];
          });
          fillForm(merged);
          wizardNote("✨ AI 已补全档案，你已填的内容全部原样保留。请检查后保存。");
        } else if (s.assist.text) {
          // 续写模式：只追加，绝不覆盖
          appendField(s.assist.field, s.assist.text);
          wizardNote("✨ 已续写至对应栏目（原内容一字未动）。" + (s.assist.note ? " " + s.assist.note : ""));
        }
      } else if (s.error) {
        wizardNote("⚠ " + s.error);
      }
    })
    .catch((e) => wizardNote("⚠ " + e.message))
    .finally(() => {
      busy = false;
      setBusy(false);
      btn.textContent = orig;
    });
}

/* ---------- 世界观讨论区 ---------- */

function renderDiscussResult(a) {
  const item = document.createElement("div");
  item.className = "d-item";
  const sum = document.createElement("div");
  sum.className = "d-summary";
  sum.textContent = "🤖 " + a.summary;
  item.appendChild(sum);
  const opts = document.createElement("div");
  opts.className = "d-opts";
  (a.options || []).forEach((optText) => {
    const b = document.createElement("button");
    b.className = "d-opt";
    b.textContent = optText;
    b.onclick = () => {
      appendField("world", optText);
      b.classList.add("done");
      b.disabled = true;
      b.textContent = "✓ 已加入世界观";
      wizardNote("已把该方向追加到「世界观背景」栏（原内容未动）。");
    };
    opts.appendChild(b);
  });
  item.appendChild(opts);
  $("#discuss-msgs").appendChild(item);
  $("#discuss-msgs").scrollTop = $("#discuss-msgs").scrollHeight;
}

function postDiscuss(text) {
  if (busy || !text) return;
  busy = true;
  setBusy(true);
  const btn = $("#btn-discuss");
  const orig = btn.textContent;
  btn.textContent = "💭 思考中……";
  const askEl = document.createElement("div");
  askEl.className = "d-item";
  const q = document.createElement("div");
  q.className = "d-summary";
  q.textContent = "你：" + text;
  askEl.appendChild(q);
  $("#discuss-msgs").appendChild(askEl);
  $("#discuss-msgs").scrollTop = $("#discuss-msgs").scrollHeight;
  call({ action: "ai_discuss", text, draft: collectDraft() })
    .then((s) => {
      state = s;
      if (s.assist && s.assist.field === "discuss") {
        renderDiscussResult(s.assist);
      } else if (s.error) {
        wizardNote("⚠ " + s.error);
      }
    })
    .catch((e) => wizardNote("⚠ " + e.message))
    .finally(() => {
      busy = false;
      setBusy(false);
      btn.textContent = orig;
    });
}

$("#btn-discuss").addEventListener("click", () => {
  const v = $("#discuss-input").value.trim();
  if (!v) return;
  $("#discuss-input").value = "";
  postDiscuss(v);
});
$("#discuss-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-discuss").click();
});

function addSys(text) {
  const el = document.createElement("div");
  el.className = "welcome sys";
  el.textContent = text;
  logEl.appendChild(el);
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

/* ================= 屏一切换 ================= */

function showScreen(name) {
  ["screen-worlds", "screen-wizard", "screen-game"].forEach((id) => {
    $("#" + id).classList.toggle("hidden", id !== name);
  });
}

/* ================= 世界列表 ================= */

function renderWorlds(s) {
  const box = $("#worlds-list");
  box.innerHTML = "";
  if (!s.worlds.length) {
    box.innerHTML =
      '<div class="empty-tip">还没有世界档案。<br>点击下方「➕ 创建新世界」，先写下你的世界设定；<br>没灵感的话，可以让 AI 帮你生成。</div>';
  }
  s.worlds.forEach((w) => {
    const card = document.createElement("div");
    card.className = "world-card";
    const date = w.updated_at ? new Date(w.updated_at * 1000).toLocaleString("zh-CN") : "尚未开始";
    card.innerHTML =
      `<div class="wc-main">
        <div class="wc-name">${escapeHtml(w.name)}</div>
        <div class="wc-desc">${escapeHtml(w.desc || "")}</div>
        <div class="wc-meta">剧情 ${w.count} 段 · 上次游玩：${date}</div>
      </div>
      <div class="wc-btns">
        <button class="btn-open" data-open="${w.id}">▶ 进入世界</button>
        <button class="btn-rename" data-rename="${w.id}">✏️ 重命名</button>
        <button class="btn-del" data-del="${w.id}">🗑 删除</button>
      </div>`;
    box.appendChild(card);
  });
  box.querySelectorAll("[data-open]").forEach((b) => {
    b.onclick = () => post({ action: "world_open", id: b.dataset.open });
  });
  box.querySelectorAll("[data-rename]").forEach((b) => {
    b.onclick = () => {
      const w = s.worlds.find((x) => x.id === b.dataset.rename);
      promptDialog("重命名世界", "输入新名称（记忆不会丢失）", w ? w.name : "", (name) => {
        post({ action: "world_rename", id: b.dataset.rename, name }, { noTyping: true });
      });
    };
  });
  box.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => {
      const w = s.worlds.find((x) => x.id === b.dataset.del);
      confirmDialog(
        "删除世界",
        `确定删除世界「${w ? w.name : ""}」吗？<br>该世界的档案将被删除，但<b>对话记忆会自动备份</b>，不会丢失。`,
        () => post({ action: "world_delete", id: b.dataset.del })
      );
    };
  });
}

/* ================= 向导 ================= */

function collectDraft() {
  return {
    name: $("#f-name").value.trim(),
    desc: $("#f-desc").value.trim(),
    world: $("#f-world").value.trim(),
    protagonist: $("#f-protagonist").value.trim(),
    characters: $("#f-characters").value.trim(),
    style: $("#f-style").value.trim(),
    rules: $("#f-rules").value.trim(),
    realism: (document.querySelector('input[name="realism"]:checked') || {}).value || "2",
    output_len: $("#f-out-len").value || "2",
    show_status: $("#f-out-status").checked ? "1" : "0",
    status_detail: $("#f-out-detail").value || "3",
    options_on: $("#f-opt-on").checked ? "1" : "0",
    options_count: $("#f-opt-count").value || "3",
    options_len: $("#f-opt-len").value || "2",
  };
}

function fillForm(p) {
  $("#f-name").value = p.name || $("#f-name").value;
  $("#f-desc").value = p.desc || $("#f-desc").value;
  $("#f-world").value = p.world || $("#f-world").value;
  $("#f-protagonist").value = p.protagonist || $("#f-protagonist").value;
  $("#f-characters").value = p.characters || $("#f-characters").value;
  $("#f-style").value = p.style || $("#f-style").value;
  $("#f-rules").value = p.rules || $("#f-rules").value;
  if (p.realism) {
    const rv = document.querySelector('input[name="realism"][value="' + p.realism + '"]');
    if (rv) rv.checked = true;
  }
  if (p.output_len) $("#f-out-len").value = p.output_len;
  if (p.show_status !== undefined && p.show_status !== null) {
    $("#f-out-status").checked = p.show_status !== "0";
  }
  if (p.status_detail) $("#f-out-detail").value = p.status_detail;
  if (p.options_on !== undefined && p.options_on !== null) {
    $("#f-opt-on").checked = p.options_on === "1";
  }
  if (p.options_count) $("#f-opt-count").value = p.options_count;
  if (p.options_len) $("#f-opt-len").value = p.options_len;
}

function setField(field, text) {
  const map = {
    world: "#f-world", protagonist: "#f-protagonist", characters: "#f-characters",
    style: "#f-style", rules: "#f-rules", desc: "#f-desc",
  };
  if (map[field]) $(map[field]).value = text;
}

function openWizard(mode) {
  wizardMode = mode;
  $("#wizard-title").textContent = mode === "create" ? "创建新世界" : "编辑世界档案";
  if (mode === "create") {
    fillForm({});
  } else if (state && state.current) {
    fillForm(state.current.profile);
  }
  showScreen("screen-wizard");
}

/* ================= 游戏界面 ================= */

function removePending() {
  if (pendingEl) {
    pendingEl.remove();
    pendingEl = null;
  }
}

function addMeBubble(text) {
  const el = document.createElement("div");
  el.className = "msg me";
  el.innerHTML = `<div class="who">我</div><div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  logEl.appendChild(el);
  scrollEl.scrollTop = scrollEl.scrollHeight;
  return el;
}

function buildOptionBox(blockText) {
  const box = document.createElement("div");
  box.className = "option-box";
  const lines = String(blockText).split("\n").map((x) => x.trim()).filter(Boolean);
  lines.forEach((line) => {
    const mm = /^\d+[\.、．]\s*(.+)$/.exec(line);
    if (!mm) return;
    const btn = document.createElement("button");
    btn.className = "opt-btn";
    btn.textContent = mm[1];
    btn.title = "点击选择此行动";
    btn.onclick = () => {
      if (busy) return;
      box.querySelectorAll(".opt-btn").forEach((x) => (x.disabled = true));
      post({ action: "say", text: mm[1] });
    };
    box.appendChild(btn);
  });
  return box;
}

function appendMsg(m, isLast, idx) {
  // 图片消息：渲染为插图气泡（已是对话的一部分，持久保存）
  if (m.role === "image") {
    const el = document.createElement("div");
    el.className = "msg ai";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = "万象";
    const b = document.createElement("div");
    b.className = "bubble img-bubble";
    const img = document.createElement("img");
    img.src = "/images/" + encodeURIComponent(m.content) + "?code=" + encodeURIComponent(wxCode) +
      "&device=" + encodeURIComponent(deviceId());
    img.alt = "剧情插图";
    const cap = document.createElement("div");
    cap.className = "img-cap";
    cap.textContent = "🎨 剧情插图（已自动保存）";
    const tools = document.createElement("div");
    tools.className = "tools";
    const del = document.createElement("button");
    del.className = "del-btn";
    del.textContent = "✕ 删除";
    del.title = "只删除这一条消息（之后的对话保留）";
    del.onclick = () => {
      confirmDialog(
        "删除这条消息",
        "只删除这一条消息，<b>之后的对话会全部保留</b>（删除前会自动备份）。<br>继续对话时，AI 将不再记得这一条。<br><br>确定删除吗？",
        () => post({ action: "delete_msg", index: idx }, { noTyping: true })
      );
    };
    tools.appendChild(del);
    b.appendChild(img);
    b.appendChild(cap);
    b.appendChild(tools);
    el.appendChild(who);
    el.appendChild(b);
    logEl.appendChild(el);
    scrollEl.scrollTop = scrollEl.scrollHeight;
    renderedMsgs.push({ el, role: m.role, content: m.content, idx, segments: m.segments });
    return;
  }
  const el = document.createElement("div");
  el.className = "msg " + (m.role === "assistant" ? "ai" : "me");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "assistant" ? "万象" : "我";
  const b = document.createElement("div");
  b.className = "bubble";
  const t = document.createElement("div");
  if (m.role === "assistant") {
    const cutS = m.content.indexOf("【世界状态】");
    const cutO = m.content.indexOf("【行动选项】");
    const c1 = cutS < 0 ? m.content.length : cutS;
    const c2 = cutO < 0 ? m.content.length : cutO;
    t.textContent = m.content.slice(0, Math.min(c1, c2)).trim();
    b.appendChild(t);
    if (cutS >= 0 && cutS < c2) {
      // 状态块
      const sb = document.createElement("div");
      sb.className = "status-box";
      sb.textContent = m.content.slice(cutS, c2).trim();
      b.appendChild(sb);
    }
    if (cutO >= 0 && cutO < m.content.length) {
      b.appendChild(buildOptionBox(m.content.slice(cutO)));
    }
  } else {
    t.textContent = m.content;
    b.appendChild(t);
  }
  t.onclick = () => {
    if (!SelMode.on) return;
    if (SelMode.set.has(idx)) {
      SelMode.set.delete(idx);
      el.classList.remove("selected");
    } else {
      SelMode.set.add(idx);
      el.classList.add("selected");
    }
    updatePlayerBar();
  };
  if (m.role === "assistant" && m.reasoning && state && state.settings.show_reasoning) {
    const d = document.createElement("details");
    d.className = "think";
    d.innerHTML = "<summary>💭 思考过程（点击展开）</summary><div class='reasoning'></div>";
    d.querySelector(".reasoning").textContent = m.reasoning;
    b.appendChild(d);
  }
  const tools = document.createElement("div");
  tools.className = "tools";
  const del = document.createElement("button");
  del.className = "del-btn";
  del.textContent = "✕ 删除";
  del.title = "只删除这一条消息（之后的对话保留）";
  del.onclick = () => {
    confirmDialog(
      "删除这条消息",
      "只删除这一条消息，<b>之后的对话会全部保留</b>（删除前会自动备份）。<br>继续对话时，AI 将不再记得这一条。<br><br>确定删除吗？",
      () => post({ action: "delete_msg", index: idx }, { noTyping: true })
    );
  };
  tools.appendChild(del);
  if (m.role === "assistant") {
    const read = document.createElement("button");
    read.textContent = "🔊 朗读";
    read.title = "朗读这条回复（再次点击重播）";
    read.onclick = () => TTS.speak(m.content);
    tools.appendChild(read);
  }
  if (m.role === "assistant" && isLast) {
    const reg = document.createElement("button");
    reg.textContent = "⟳ 换种写法";
    reg.onclick = () => post({ action: "regenerate" });
    tools.appendChild(reg);
    lastAiEl = el;
  }
  b.appendChild(tools);
  el.appendChild(who);
  el.appendChild(b);
  logEl.appendChild(el);
  scrollEl.scrollTop = scrollEl.scrollHeight;
  renderedMsgs.push({ el, role: m.role, content: m.content, idx, segments: m.segments });
}

function applyState(s) {
  state = s;
  wxLocalBadge();
  // 云端进度为空时，用本机存档自动恢复
  wxMaybeRestore(s);
  // 存档变化后，自动把最新进度备份到本机浏览器
  if (["say", "start", "world_create", "world_delete", "world_edit",
       "delete_msg", "regenerate", "restart"].includes(s.op)) {
    wxScheduleDump();
  }
  // 切换世界/重开/删除时停止朗读并清空配音缓存，避免队列错位
  if (s.mode !== "game" ||
      ["world_open", "world_create", "world_edit", "restart", "start", "delete_msg"].includes(s.op)) {
    if (TTS.active) TTS.stop();
    TTS.clearCache();
  }
  if (AutoScroll.on && (s.mode !== "game" ||
      ["say", "start", "regenerate", "restart", "world_open", "world_create", "world_edit", "delete_msg", "image_gen"].includes(s.op))) {
    AutoScroll.stop(false);
  }
  renderGlobalStatus(s);
  if (s.error) addSys("⚠ " + s.error);

  if (s.mode === "worlds") {
    showScreen("screen-worlds");
    renderWorlds(s);
    return;
  }

  // 游戏模式
  showScreen("screen-game");
  renderProfile(s);
  renderSaved(s);

  // 进入/创建/编辑世界后自动识别角色（每个世界观都会执行）
  if (["world_open", "world_create", "world_edit"].includes(s.op)) {
    if (s.op === "world_edit") {
      const wid = currentWorldId();
      if (wid) clearCharData(wid);
    }
    analyzeCharacters(false);
  }

  const FULL_RESET = ["world_open", "world_create", "world_edit", "restart", "start", "settings", "delete_msg"];
  if (FULL_RESET.includes(s.op)) {
    logEl.innerHTML = "";
    rendered = [];
    renderedMsgs = [];
    lastAiEl = null;
    if (!s.current || !s.current.history.length) {
      logEl.innerHTML =
        '<div class="welcome">✦ 欢迎来到「' + escapeHtml((s.current && s.current.profile.name) || "") +
        '」 ✦<br>点击右侧「🚀 开始冒险」，AI 将按你的档案写出世界开篇。<br>此后输入任何想做的事，故事由你书写。<br><span style="color:#b3332a">注：所有进度自动保存，切换世界互不影响。</span></div>';
    }
  }

  if (s.op === "regenerate") {
    if (lastAiEl) {
      lastAiEl.remove();
      lastAiEl = null;
      renderedMsgs.pop();
    }
    rendered = rendered.slice(0, s.history.length - 1);
  }

  const hist = s.current ? s.current.history : [];
  if (hist.length < rendered.length) {
    logEl.innerHTML = "";
    rendered = [];
    renderedMsgs = [];
    lastAiEl = null;
  }
  const offset = (s.current && s.current.hist_offset) || 0;
  for (let i = rendered.length; i < hist.length; i++) {
    appendMsg(hist[i], i === hist.length - 1, offset + i);
  }
  rendered = hist;

  // 自动朗读：新生成的 AI 回复自动读出
  if (TTS.enabled && ["say", "start", "regenerate"].includes(s.op)) {
    const last = hist[hist.length - 1];
    if (last && last.role === "assistant" && last.content) TTS.speak(last.content);
  }

  // 无记忆时显示开始提示
  if (!hist.length && !logEl.querySelector(".welcome")) {
    const w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = "✦ 这个世界还没有记忆。<br>点击右侧「🚀 开始冒险」，让 AI 写下开篇。";
    logEl.appendChild(w);
  }
}

function renderGlobalStatus(s) {
  const ai = $("#st-ai");
  if (s.settings.api_ready) {
    ai.textContent = "AI：已连接";
    ai.className = "ok";
  } else {
    ai.textContent = "AI：未连接（去设置填密钥）";
    ai.className = "bad";
  }
  const img = $("#st-img");
  if (s.settings.img_ready) {
    img.textContent = "🎨 图像：已连接";
    img.className = "ok";
  } else {
    img.textContent = "🎨 图像：未配置";
    img.className = "bad";
  }
  $("#st-reasoning").textContent = "显示思考过程：" + (s.settings.show_reasoning ? "开" : "关");
}

function renderSaved(s) {
  $("#st-saved").textContent = s.saved_at ? "💾 已自动保存 " + s.saved_at : "💾 自动保存已开启";
}

function renderProfile(s) {
  const p = (s.current && s.current.profile) || {};
  $("#p-name").textContent = p.name || "未命名世界";
  $("#g-world-name").textContent = p.name || "";
  $("#p-desc").textContent = p.desc || "";
  const parts = [];
  if (p.world) parts.push("世界观 " + p.world.length + "字");
  if (p.characters) parts.push("人物 " + p.characters.length + "字");
  if (p.style) parts.push("文风 " + p.style.length + "字");
  $("#p-meta").textContent = parts.join(" · ");
  // 真实程度
  const rv = String(p.realism || "2");
  const sel = $("#sel-realism");
  if (sel && sel.value !== rv) sel.value = rv;
  // 文本输出设置
  const olen = String(p.output_len || "2");
  const os = $("#sel-out-len");
  if (os && os.value !== olen) os.value = olen;
  const od = $("#sel-out-detail");
  const odv = String(p.status_detail || "3");
  if (od && od.value !== odv) od.value = odv;
  const ost = $("#sel-out-status");
  if (ost) ost.checked = String(p.show_status || "1") !== "0";
  // 行动选项
  const oon = $("#sel-opt-on");
  if (oon) oon.checked = String(p.options_on || "0") === "1";
  const oc = $("#sel-opt-count");
  const ocv = String(p.options_count || "3");
  if (oc && oc.value !== ocv) oc.value = ocv;
  const ol = $("#sel-opt-len");
  const olv = String(p.options_len || "2");
  if (ol && ol.value !== olv) ol.value = olv;
}

$("#sel-realism").addEventListener("change", (e) => {
  post({ action: "set_realism", level: e.target.value }, { noTyping: true });
});
function saveOutputSettings() {
  post({
    action: "set_output",
    output_len: $("#sel-out-len").value,
    show_status: $("#sel-out-status").checked ? "1" : "0",
    status_detail: $("#sel-out-detail").value,
    options_on: $("#sel-opt-on").checked ? "1" : "0",
    options_count: $("#sel-opt-count").value,
    options_len: $("#sel-opt-len").value,
  }, { noTyping: true });
}
$("#sel-out-len").addEventListener("change", saveOutputSettings);
$("#sel-out-detail").addEventListener("change", saveOutputSettings);
$("#sel-out-status").addEventListener("change", saveOutputSettings);
$("#sel-opt-on").addEventListener("change", saveOutputSettings);
$("#sel-opt-count").addEventListener("change", saveOutputSettings);
$("#sel-opt-len").addEventListener("change", saveOutputSettings);

/* ================= 全屏 ================= */

const fsBtn = $("#btn-fullscreen");
function updateFsBtn() {
  fsBtn.textContent = document.fullscreenElement ? "🗗 退出全屏（或按 Esc）" : "⛶ 进入全屏";
}
fsBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => addSys("⚠ 浏览器不允许全屏，请刷新后重试"));
  } else {
    document.exitFullscreen().catch(() => {});
  }
});
document.addEventListener("fullscreenchange", updateFsBtn);

/* ================= 对话总览 ================= */

function openOverview() {
  const box = $("#overview-list");
  box.innerHTML = "";
  if (!renderedMsgs.length) {
    box.innerHTML = '<div class="ov-empty">还没有对话内容<br>点击「🚀 开始冒险」开始故事吧</div>';
  }
  renderedMsgs.forEach((m, i) => {
    const d = document.createElement("div");
    d.className = "ov-item";
    const isText = m.role === "user" || m.role === "assistant";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "ov-cb";
    cb.checked = SelMode.set.has(m.idx);
    cb.disabled = !isText;
    cb.title = isText ? "勾选加入连播" : "插图不可朗读";
    cb.onclick = (e) => {
      e.stopPropagation();
      if (SelMode.set.has(m.idx)) {
        SelMode.set.delete(m.idx);
        cb.checked = false;
      } else {
        SelMode.set.add(m.idx);
        cb.checked = true;
      }
      // 同步主界面气泡的高亮
      if (m.el) m.el.classList.toggle("selected", SelMode.set.has(m.idx));
      updateOverviewSel();
      updatePlayerBar();
    };
    const who = m.role === "assistant" ? "万象" : (m.role === "image" ? "万象🖼" : "我");
    const preview = m.role === "image" ? "剧情插图" : m.content.replace(/\s+/g, " ").slice(0, 42);
    d.appendChild(cb);
    const idxSpan = document.createElement("span");
    idxSpan.className = "ov-idx";
    idxSpan.textContent = i + 1;
    const whoSpan = document.createElement("span");
    whoSpan.className = "ov-who " + m.role;
    whoSpan.textContent = who;
    const textSpan = document.createElement("span");
    textSpan.className = "ov-text";
    textSpan.textContent = preview + (m.content.length > 42 ? "…" : "");
    d.appendChild(idxSpan);
    d.appendChild(whoSpan);
    d.appendChild(textSpan);
    d.onclick = () => {
      closeOverview();
      if (AutoScroll.on) AutoScroll.stop(false);
      m.el.scrollIntoView({ behavior: "smooth", block: "center" });
      m.el.classList.add("flash");
      setTimeout(() => m.el.classList.remove("flash"), 1700);
    };
    box.appendChild(d);
  });
  $("#ov-count").textContent = `（共 ${renderedMsgs.length} 条）`;
  updateOverviewSel();
  $("#overview-mask").classList.remove("hidden");
}

function updateOverviewSel() {
  const n = SelMode.set.size;
  $("#ov-sel-count").textContent = n ? `已勾选 ${n} 条` : "";
  $("#ov-play").disabled = n === 0;
}

$("#ov-sel-all").addEventListener("click", () => {
  SelMode.set.clear();
  renderedMsgs.forEach((m) => {
    if (m.role === "user" || m.role === "assistant") {
      SelMode.set.add(m.idx);
      if (m.el) m.el.classList.add("selected");
    }
  });
  openOverview();
  updatePlayerBar();
});
$("#ov-sel-clear").addEventListener("click", () => {
  SelMode.set.clear();
  document.querySelectorAll(".msg.selected").forEach((e) => e.classList.remove("selected"));
  openOverview();
  updatePlayerBar();
});
$("#ov-play").addEventListener("click", () => {
  if (!SelMode.set.size) return;
  closeOverview();
  TTS.playQueue(textPlaylist(true));
});

function closeOverview() {
  $("#overview-mask").classList.add("hidden");
}

$("#btn-overview").addEventListener("click", openOverview);
$("#btn-close-overview").addEventListener("click", closeOverview);
$("#overview-mask").addEventListener("click", (e) => {
  if (e.target === $("#overview-mask")) closeOverview();
});

/* ================= 确认弹窗 ================= */

let confirmCb = null;
function confirmDialog(title, textHtml, cb) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").innerHTML = textHtml;
  confirmCb = cb;
  $("#confirm-mask").classList.remove("hidden");
}
$("#confirm-ok").addEventListener("click", () => {
  $("#confirm-mask").classList.add("hidden");
  const cb = confirmCb;
  confirmCb = null;
  if (cb) cb();
});
$("#confirm-cancel").addEventListener("click", () => {
  $("#confirm-mask").classList.add("hidden");
  confirmCb = null;
});

/* ================= 事件绑定 ================= */

// 世界列表
$("#btn-create").addEventListener("click", () => openWizard("create"));

// 向导
$("#btn-ai-all").addEventListener("click", (e) => {
  const name = $("#f-name").value.trim();
  if (!name) {
    confirmDialog("需要先起个名字", "请先填写「世界名称」，AI 才能围绕它生成档案。<br>（名字之后也可以修改）", null);
    return;
  }
  postAssist("all", e.target);
});
$("#btn-ai-from-brief").addEventListener("click", (e) => {
  const name = $("#f-name").value.trim();
  const desc = $("#f-desc").value.trim();
  if (!name && !desc) {
    wizardNote("⚠ 请至少填写「世界名称」或「一句话简介」，AI 才有依据生成。");
    return;
  }
  postAssist("all", e.target);
});

// ---------- 修改意见弹窗 ----------
const REVISE_FIELD_IDS = {
  world: "#rv-world", protagonist: "#rv-protagonist", characters: "#rv-characters",
  style: "#rv-style", rules: "#rv-rules",
};
const REVISE_LABELS = {
  world: "世界观背景", protagonist: "主角设定", characters: "人物设定",
  style: "文风要求", rules: "额外规则",
};
$("#btn-open-revise").addEventListener("click", () => {
  $("#revise-input").value = "";
  $("#revise-err").textContent = "";
  $("#revise-mask").classList.remove("hidden");
  setTimeout(() => $("#revise-input").focus(), 60);
});
$("#revise-cancel").addEventListener("click", () => {
  $("#revise-mask").classList.add("hidden");
});
$("#revise-mask").addEventListener("click", (e) => {
  if (e.target === $("#revise-mask")) $("#revise-mask").classList.add("hidden");
});
$("#rv-all").addEventListener("change", (e) => {
  Object.keys(REVISE_FIELD_IDS).forEach((k) => {
    $(REVISE_FIELD_IDS[k]).checked = e.target.checked;
  });
});
$("#revise-go").addEventListener("click", () => {
  const inst = $("#revise-input").value.trim();
  if (!inst) {
    $("#revise-err").textContent = "⚠ 请先写下你的修改意见。";
    return;
  }
  const fields = Object.keys(REVISE_FIELD_IDS).filter((k) => $(REVISE_FIELD_IDS[k]).checked);
  if (!fields.length) {
    $("#revise-err").textContent = "⚠ 请至少勾选一个要修改的栏目。";
    return;
  }
  if (busy) return;
  busy = true;
  setBusy(true);
  const btn = $("#revise-go");
  const orig = btn.textContent;
  btn.textContent = "💭 修改中……";
  call({ action: "ai_revise", fields, instruction: inst, draft: collectDraft() })
    .then((s) => {
      state = s;
      if (s.assist && s.assist.field === "ai_revise" && s.assist.profile) {
        fillForm(s.assist.profile);
        $("#revise-mask").classList.add("hidden");
        const labels = fields.map((k) => REVISE_LABELS[k] || k);
        wizardNote("✨ 已按你的意见修改：" + labels.join("、") + "。请检查后保存。");
      } else if (s.error) {
        $("#revise-err").textContent = "⚠ " + s.error;
      }
    })
    .catch((e) => {
      $("#revise-err").textContent = "⚠ " + e.message;
    })
    .finally(() => {
      busy = false;
      setBusy(false);
      btn.textContent = orig;
    });
});
document.querySelectorAll(".ai-btn").forEach((b) => {
  b.addEventListener("click", (e) => postAssist(e.target.dataset.field, e.target));
});
$("#btn-save-world").addEventListener("click", () => {
  const draft = collectDraft();
  if (!draft.name) {
    confirmDialog("需要世界名称", "请先填写「世界名称」再保存。", null);
    return;
  }
  const action = wizardMode === "create" ? "world_create" : "world_edit";
  post({ action, profile: draft }, { noTyping: true });
});
$("#btn-cancel-wizard").addEventListener("click", () => {
  if (wizardMode === "edit") {
    post({ action: "state" }, { noTyping: true });
  } else {
    post({ action: "back_to_worlds" }, { noTyping: true });
  }
});

// 游戏侧栏
$("#btn-start").addEventListener("click", () => {
  if (state.current && state.current.has_memory) {
    confirmDialog(
      "开始新冒险",
      "这会清空本世界的当前对话并让 AI 重写开篇。<br>旧对话会<b>自动备份</b>到 backups 文件夹，不会丢失。<br><br>确定开始吗？",
      () => post({ action: "restart" }).then(() => post({ action: "start" }))
    );
  } else {
    post({ action: "start" });
  }
});
$("#btn-edit").addEventListener("click", () => openWizard("edit"));
$("#btn-switch").addEventListener("click", () => post({ action: "back_to_worlds" }, { noTyping: true }));
$("#btn-restart").addEventListener("click", () => {
  confirmDialog(
    "重新开始本世界",
    "这会清空本世界的当前对话。<br>旧对话会<b>自动备份</b>到 backups 文件夹，不会丢失。<br><br>确定重新开始吗？",
    () => post({ action: "restart" })
  );
});
$("#btn-settings").addEventListener("click", () => {
  try { $("#s-show-reasoning").checked = state.settings.show_reasoning; } catch (e) {}
  try { $("#s-tts-on").checked = TTS.enabled; } catch (e) {}
  try {
    $("#tts-mode-normal").checked = TTS.mode === "normal";
    $("#tts-mode-cast").checked = TTS.mode === "cast";
  } catch (e) {}
  try {
    const code = (state.settings && state.settings.access_code) || "";
    $("#s-phone-info").textContent = "🔑 本游戏访问码：" + code + "（手机打开网址后输入此码即可进入）";
  } catch (e) {}
  try {
    const ck = (state.settings && state.settings.chunk) || {};
    $("#s-chunk-on").checked = ck.enabled !== false;
    if (ck.part_chars) $("#s-chunk-part").value = String(ck.part_chars);
    if (ck.max_parts) $("#s-chunk-max").value = String(ck.max_parts);
    $("#s-chunk-mode").value = (state.settings && state.settings.chunk_mode) || "auto";
    updateChunkHint();
  } catch (e) {}
  try { buildVoiceCastGrid(state.tts_voices || {}); } catch (e) {}
  try { renderCharList(); } catch (e) {}
  try { renderProviderPanel(); } catch (e) {}
  $("#settings-mask").classList.remove("hidden");
});
$("#s-show-reasoning").addEventListener("change", (e) => {
  post({ action: "settings", show_reasoning: e.target.checked }, { noTyping: true });
});

// ---------- 长文分段生成 ----------
function updateChunkHint() {
  const s = (state && state.settings) || {};
  const cap = s.single_cap || 0;
  const model = s.active_model || "";
  const mode = $("#s-chunk-mode") ? $("#s-chunk-mode").value : (s.chunk_mode || "auto");
  const lv = (state && state.current && state.current.output_len) || "2";
  const target = { "1": 250, "2": 500, "3": 900, "4": 1400, "5": 1800, "6": 2800 }[String(lv)] || 500;
  const el = $("#chunk-hint");
  if (!el) return;
  if (mode === "off") {
    el.textContent = "已关闭分段：无论多长都一次写完（" + model + "）。";
  } else if (mode === "on") {
    el.textContent = "强制分段：每次长文都会拆成多段请求再合并（" + model + "）。";
  } else {
    el.textContent = "当前模型 " + model + " 一次可写约 " + cap + " 字；" +
      (target > cap
        ? "当前档位（" + target + "字）超出其一次输出能力，将自动分段生成再合并。"
        : "当前档位（" + target + "字）在能力范围内，一次写完，不分段。");
  }
}

function saveChunkSettings() {
  post({
    action: "chunk_save",
    enabled: $("#s-chunk-on").checked,
    part_chars: $("#s-chunk-part").value,
    max_parts: $("#s-chunk-max").value,
    mode: $("#s-chunk-mode").value,
  }, { noTyping: true }).then(updateChunkHint);
}
$("#s-chunk-on").addEventListener("change", saveChunkSettings);
$("#s-chunk-part").addEventListener("change", saveChunkSettings);
$("#s-chunk-max").addEventListener("change", saveChunkSettings);
$("#s-chunk-mode").addEventListener("change", saveChunkSettings);
$("#s-tts-on").addEventListener("change", (e) => {
  TTS.enabled = e.target.checked;
  localStorage.setItem("wx_tts_on", TTS.enabled ? "1" : "0");
  if (!TTS.enabled) TTS.stop();
});
function setTtsMode(mode) {
  if (TTS.mode === mode) return;
  TTS.mode = mode;
  localStorage.setItem("wx_tts_mode", mode);
  if (TTS.active) TTS.stop();
  TTS.clearCache();
}
$("#tts-mode-normal").addEventListener("change", (e) => {
  if (e.target.checked) setTtsMode("normal");
});
$("#tts-mode-cast").addEventListener("change", (e) => {
  if (e.target.checked) setTtsMode("cast");
});
$("#btn-close-settings").addEventListener("click", () => {
  $("#settings-mask").classList.add("hidden");
});
$("#settings-mask").addEventListener("click", (e) => {
  if (e.target === $("#settings-mask")) $("#settings-mask").classList.add("hidden");
});

/* ================= API 接口管理 ================= */

// 各厂商的候选对话模型（下拉可选；也可点「获取模型列表」拉取该密钥真实可用模型）
const PROVIDER_MODELS = {
  deepseek: [
    ["deepseek-v4-pro", "DeepSeek-V4-Pro（强）"],
    ["deepseek-flash", "DeepSeek-V4.1-Flash（快 · 更便宜）"],
  ],
  zhipu: [
    ["glm-4-flash", "智谱 GLM-4-Flash（永久免费）"],
    ["glm-4-plus", "智谱 GLM-4-Plus"],
    ["glm-4-air", "智谱 GLM-4-Air"],
  ],
  siliconflow: [
    ["deepseek-ai/DeepSeek-V3", "硅基流动 DeepSeek-V3"],
    ["deepseek-ai/DeepSeek-R1", "硅基流动 DeepSeek-R1"],
    ["Qwen/Qwen2.5-72B-Instruct", "Qwen2.5-72B"],
  ],
  openrouter: [
    ["deepseek/deepseek-v4-flash:free", "DeepSeek V4.1-Flash（免费版）"],
    ["deepseek/deepseek-v4-pro", "DeepSeek V4-Pro"],
    ["deepseek/deepseek-chat-v3.1:free", "DeepSeek V3.1（免费版）"],
  ],
  modelscope: [
    ["deepseek-ai/DeepSeek-V3.1", "魔搭 DeepSeek-V3.1"],
    ["Qwen/Qwen2.5-7B-Instruct", "魔搭 Qwen2.5-7B"],
  ],
  chutes: [
    ["deepseek-ai/DeepSeek-V4-Flash", "DeepSeek V4.1-Flash"],
    ["deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4-Pro"],
  ],
  openai: [
    ["gpt-4o-mini", "gpt-4o-mini"],
    ["gpt-4o", "gpt-4o"],
    ["gpt-4.1", "gpt-4.1"],
  ],
  kimi: [
    ["moonshot-v1-8k", "moonshot-v1-8k"],
    ["moonshot-v1-32k", "moonshot-v1-32k"],
    ["kimi-k2-0711-preview", "Kimi K2"],
  ],
  qwen: [
    ["qwen-plus", "qwen-plus"],
    ["qwen-max", "qwen-max"],
    ["qwen-turbo", "qwen-turbo"],
  ],
  default: [
    ["deepseek-v4-pro", "DeepSeek-V4-Pro（强）"],
    ["deepseek-flash", "DeepSeek-V4.1-Flash（快 · 更便宜）"],
  ],
};

// 模型下拉选项：厂商候选 + 当前值（若不在候选内）+ 「自定义」项
function modelSelectOptions(pid, current) {
  const list = (PROVIDER_MODELS[pid] || PROVIDER_MODELS.default).slice();
  if (current && !list.some((pair) => pair[0] === current)) {
    list.push([current, "当前：" + current]);
  }
  return list
    .map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`)
    .join("") +
    `<option value="__custom__">✍ 自定义（手动输入）</option>`;
}

function currentModelOf(card) {
  const sel = card.querySelector('[data-k="model"]');
  if (!sel) return "";
  if (sel.value === "__custom__") {
    const cu = card.querySelector('[data-k="model_custom"]');
    return cu ? cu.value.trim() : "";
  }
  return sel.value.trim();
}

function renderProviderPanel() {
  const provs = state.providers || {};
  // 下拉选择器
  const selText = $("#sel-text");
  const selImage = $("#sel-image");
  selText.innerHTML = "";
  selImage.innerHTML = "";
  Object.keys(provs).forEach((pid) => {
    const p = provs[pid];
    const opt = document.createElement("option");
    opt.value = pid;
    opt.textContent = p.name + (p.api_key ? " ✓" : "（未填密钥）");
    selText.appendChild(opt);
  });
  Object.keys(provs).forEach((pid) => {
    const p = provs[pid];
    const opt = document.createElement("option");
    opt.value = pid;
    opt.textContent = p.name + (p.api_key ? " ✓" : "（未填密钥）");
    selImage.appendChild(opt);
  });
  selText.value = state.active_text || "";
  selImage.value = state.active_image || "";

  // 厂商卡片
  const box = $("#provider-cards");
  box.innerHTML = "";
  Object.keys(provs).forEach((pid) => {
    const p = provs[pid];
    const card = document.createElement("div");
    card.className = "p-card";
    card.dataset.pid = pid;
    card.innerHTML =
      `<div class="p-head">
        <input class="p-name" data-k="name" value="${escapeHtml(p.name || "")}" placeholder="厂商名称">
        <div class="p-tags">
          <span class="p-tag">对话</span>
          ${p.img_model || p.img_api === "zhipu" ? '<span class="p-tag img">图像</span>' : ""}
          <label class="p-enable"><input type="checkbox" data-k="enabled" ${p.enabled ? "checked" : ""}>启用</label>
          <button class="p-del">✕</button>
        </div>
      </div>
      <div class="p-rows">
        <div class="p-field full"><span>接口地址 base_url</span><input data-k="base_url" value="${escapeHtml(p.base_url || "")}" placeholder="https://…"></div>
        <div class="p-field"><span>API Key</span><input type="password" data-k="api_key" value="${escapeHtml(p.api_key || "")}" placeholder="sk-…"></div>
        <div class="p-field"><span>对话模型 model（下拉选择）</span>
          <select data-k="model" class="p-model-select">
            ${modelSelectOptions(pid, p.model || "")}
          </select>
          <input data-k="model_custom" class="p-model-custom hidden" placeholder="输入自定义模型 ID">
          <div class="p-api-btns">
            <button class="p-getmodels" type="button">📋 获取模型列表</button>
            <button class="p-test" type="button">🔍 测试连接</button>
            <span class="p-test-result"></span>
          </div>
        </div>
        <div class="p-field"><span>图像模型 img_model</span><input data-k="img_model" value="${escapeHtml(p.img_model || "")}" placeholder="如 cogview-3-flash"></div>
        <div class="p-field"><span>图像接口格式 img_api</span><input data-k="img_api" value="${escapeHtml(p.img_api || "openai")}" placeholder="zhipu 或 openai"></div>
      </div>`;
    card.querySelector(".p-del").addEventListener("click", () => {
      card.remove();
    });
    const msel = card.querySelector('[data-k="model"]');
    if (msel && p.model) msel.value = p.model;
    wireApiButtons(card);
    box.appendChild(card);
  });
}

function wireApiButtons(card) {
  const getBtn = card.querySelector(".p-getmodels");
  const testBtn = card.querySelector(".p-test");
  const resultEl = card.querySelector(".p-test-result");
  if (!getBtn || !testBtn || !resultEl) return;
  const vt = (k) => {
    const el = card.querySelector('[data-k="' + k + '"]');
    return el ? el.value.trim() : "";
  };
  // 模型下拉：选择「自定义」时显示手动输入框
  const msel = card.querySelector('[data-k="model"]');
  const cu = card.querySelector('[data-k="model_custom"]');
  if (msel && cu) {
    const sync = () => {
      if (msel.value === "__custom__") {
        cu.classList.remove("hidden");
        cu.focus();
      } else {
        cu.classList.add("hidden");
      }
    };
    msel.addEventListener("change", sync);
    sync();
  }
  getBtn.addEventListener("click", () => {
    getBtn.disabled = true;
    resultEl.className = "p-test-result";
    resultEl.textContent = "⏳ 获取中……";
    call({ action: "list_models", provider: { base_url: vt("base_url"), api_key: vt("api_key") } })
      .then((s) => {
        const a = (s && s.assist) || {};
        if (a.ok && a.models && a.models.length) {
          const prev = currentModelOf(card);
          msel.innerHTML = "";
          a.models.forEach((m) => {
            const o = document.createElement("option");
            o.value = m.id;
            o.textContent = (m.name && m.name !== m.id) ? m.name + "（" + m.id + "）" : m.id;
            msel.appendChild(o);
          });
          if (prev) {
            if (!a.models.some((m) => m.id === prev)) {
              const o = document.createElement("option");
              o.value = prev;
              o.textContent = "当前：" + prev;
              msel.appendChild(o);
            }
            msel.value = prev;
          }
          const oo = document.createElement("option");
          oo.value = "__custom__";
          oo.textContent = "✍ 自定义（手动输入）";
          msel.appendChild(oo);
          if (cu && !cu.classList.contains("hidden")) cu.classList.add("hidden");
          resultEl.className = "p-test-result ok";
          resultEl.textContent = "✓ 已获取 " + a.models.length + " 个模型，下拉框可直接选择";
        } else {
          resultEl.className = "p-test-result bad";
          resultEl.textContent = "✗ " + (a.error || "未获取到模型");
        }
      })
      .catch((e) => {
        resultEl.className = "p-test-result bad";
        resultEl.textContent = "✗ " + e.message;
      })
      .finally(() => {
        getBtn.disabled = false;
      });
  });
  testBtn.addEventListener("click", () => {
    const key = vt("api_key");
    const model = currentModelOf(card);
    if (!key) {
      resultEl.className = "p-test-result bad";
      resultEl.textContent = "✗ 请先填写 API Key";
      return;
    }
    if (!model) {
      resultEl.className = "p-test-result bad";
      resultEl.textContent = "✗ 请先选择或填写对话模型";
      return;
    }
    testBtn.disabled = true;
    resultEl.className = "p-test-result";
    resultEl.textContent = "⏳ 测试中……";
    call({ action: "test_api", provider: { base_url: vt("base_url"), api_key: key, model: model } })
      .then((s) => {
        const a = (s && s.assist) || {};
        if (a.ok) {
          resultEl.className = "p-test-result ok";
          resultEl.textContent = "✓ 连接正常（" + (a.ms / 1000).toFixed(1) + " 秒 · 模型 " +
            (a.model || model) + " 回复：" + (a.reply || "正常") + "）";
        } else {
          resultEl.className = "p-test-result bad";
          resultEl.textContent = "✗ " + (a.error || "测试失败");
        }
      })
      .catch((e) => {
        resultEl.className = "p-test-result bad";
        resultEl.textContent = "✗ " + e.message;
      })
      .finally(() => {
        testBtn.disabled = false;
      });
  });
}

function collectProviders() {
  const provs = {};
  document.querySelectorAll("#provider-cards .p-card").forEach((card) => {
    const pid = card.dataset.pid || "p" + Object.keys(provs).length;
    const p = {};
    card.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (k === "model_custom") return; // 由 model 统一处理
      if (k === "enabled") p[k] = el.checked;
      else p[k] = el.value.trim();
    });
    if (p.model === "__custom__") {
      const cu = card.querySelector('[data-k="model_custom"]');
      p.model = cu ? cu.value.trim() : "";
    }
    if (p.name) provs[pid] = p;
  });
  return provs;
}

$("#btn-add-provider").addEventListener("click", () => {
  const card = document.createElement("div");
  card.className = "p-card";
  card.dataset.pid = "custom_" + Date.now();
  card.innerHTML =
    `<div class="p-head">
      <input class="p-name" data-k="name" value="" placeholder="新厂商名称">
      <div class="p-tags">
        <span class="p-tag">对话</span>
        <label class="p-enable"><input type="checkbox" data-k="enabled" checked>启用</label>
        <button class="p-del">✕</button>
      </div>
    </div>
    <div class="p-rows">
      <div class="p-field full"><span>接口地址 base_url</span><input data-k="base_url" value="" placeholder="https://…"></div>
      <div class="p-field"><span>API Key</span><input type="password" data-k="api_key" value="" placeholder="sk-…"></div>
      <div class="p-field"><span>对话模型 model（下拉选择）</span>
        <select data-k="model" class="p-model-select">
          ${modelSelectOptions("default", "")}
        </select>
        <input data-k="model_custom" class="p-model-custom hidden" placeholder="输入自定义模型 ID">
        <div class="p-api-btns">
          <button class="p-getmodels" type="button">📋 获取模型列表</button>
          <button class="p-test" type="button">🔍 测试连接</button>
          <span class="p-test-result"></span>
        </div>
      </div>
      <div class="p-field"><span>图像模型 img_model</span><input data-k="img_model" value="" placeholder=""></div>
      <div class="p-field"><span>图像接口格式 img_api</span><input data-k="img_api" value="openai" placeholder="zhipu 或 openai"></div>
    </div>`;
  card.querySelector(".p-del").addEventListener("click", () => card.remove());
  wireApiButtons(card);
  $("#provider-cards").appendChild(card);
});

$("#btn-save-providers").addEventListener("click", () => {
  const provs = collectProviders();
  post({
    action: "providers_save",
    providers: provs,
    active_text: $("#sel-text").value,
    active_image: $("#sel-image").value,
  }, { noTyping: true }).then(() => {
    if (state && !state.error) {
      $("#settings-mask").classList.add("hidden");
      confirmDialog("已保存", "API 配置已保存并立即生效。", null);
    }
  });
});

/* ================= AI 剧情生图（内联） ================= */

$("#btn-img-toggle").addEventListener("click", () => {
  const row = $("#imgrow");
  row.classList.toggle("hidden");
  $("#btn-img-toggle").classList.toggle("on", !row.classList.contains("hidden"));
  if (!row.classList.contains("hidden")) $("#img-desc").focus();
});

$("#btn-img-gen2").addEventListener("click", () => {
  if (busy) return;
  busy = true;
  setBusy(true);
  const desc = $("#img-desc").value.trim();
  $("#img-status2").textContent = "💭 正在理解剧情并生成插图……";
  call({ action: "image_gen", prompt: desc, use_context: true })
    .then((s) => {
      state = s;
      $("#img-status2").textContent = "";
      // 图片已作为对话一部分写入历史，走标准渲染管线（含持久化显示）
      applyState(s);
      $("#img-desc").value = "";
    })
    .catch((e) => {
      $("#img-status2").textContent = "⚠ " + e.message;
    })
    .finally(() => {
      busy = false;
      setBusy(false);
    });
});

$("#img-desc").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-img-gen2").click();
});

// 发送
$("#sendbtn").addEventListener("click", () => {
  const v = $("#textin").value.trim();
  if (!v) return;
  $("#textin").value = "";
  post({ action: "say", text: v });
});
$("#textin").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#sendbtn").click();
  }
});

// 输入框随内容自动长高（上限调低，不遮挡文本）
$("#textin").addEventListener("input", () => {
  const t = $("#textin");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 84) + "px";
});

/* ================= 上下键翻动对话 ================= */

function findTopIndex() {
  const top = scrollEl.getBoundingClientRect().top + 50;
  let idx = -1;
  for (let i = 0; i < renderedMsgs.length; i++) {
    const r = renderedMsgs[i].el.getBoundingClientRect();
    if (r.bottom > top) {
      idx = i;
      break;
    }
  }
  return idx === -1 ? renderedMsgs.length - 1 : idx;
}

function scrollByMsg(dir) {
  if (AutoScroll.on) AutoScroll.stop(false);
  if (!renderedMsgs.length) {
    scrollEl.scrollTop += dir * 90;
    return;
  }
  const cur = findTopIndex();
  const target = Math.max(0, Math.min(renderedMsgs.length - 1, cur + dir));
  renderedMsgs[target].el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ================= 回到最新（End 键） ================= */

document.addEventListener("keydown", (e) => {
  if (!state || state.mode !== "game") return; // 仅在游戏界面生效
  const maskOpen =
    !$("#overview-mask").classList.contains("hidden") ||
    !$("#confirm-mask").classList.contains("hidden") ||
    !$("#music-mask").classList.contains("hidden") ||
    !$("#settings-mask").classList.contains("hidden");
  if (maskOpen) return;
  const active = document.activeElement;
  const typing = active === $("#textin") && $("#textin").value.trim() !== "";
  // End 键：一键回到最新对话
  if (e.key === "End" && !typing) {
    e.preventDefault();
    if (AutoScroll.on) AutoScroll.stop(false);
    scrollEl.scrollTop = scrollEl.scrollHeight;
    return;
  }
  // ↑ ↓ 键：逐条翻动对话
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (typing) return; // 输入框有字时不拦截
  e.preventDefault();
  scrollByMsg(e.key === "ArrowUp" ? -1 : 1);
});

/* ================= 音乐系统（程序化合成 · 多风格 · 夜晚模式） ================= */

const MUSIC_STYLES = {
  ambient: {
    name: "暧昧夜色",
    chords: [
      [110.0, 164.81, 196.0, 261.63, 329.63],   // Am7
      [87.31, 130.81, 164.81, 220.0, 261.63],   // Fmaj7
      [130.81, 196.0, 246.94, 329.63, 392.0],   // Cmaj7
      [98.0, 146.83, 246.94, 329.63, 392.0],    // G6
    ],
    chordDur: 9,
    penta: [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99],
    plucks: 3,
    padGain: 0.028, bassGain: 0.05, pluckGain: 0.05,
    filter: 1000,
  },
  melancholy: {
    name: "幽怨古风",
    chords: [
      [146.83, 220.0, 261.63, 293.66, 349.23],  // Dm7（羽）
      [130.81, 196.0, 261.63, 293.66, 329.63],  // C
      [116.54, 174.61, 233.08, 261.63, 293.66], // Bb
      [110.0, 164.81, 220.0, 261.63, 329.63],   // Am7
    ],
    chordDur: 14,
    penta: [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99, 880.0],
    plucks: 2,
    padGain: 0.024, bassGain: 0.045, pluckGain: 0.04,
    filter: 800,
  },
  ethereal: {
    name: "仙气缥缈",
    chords: [
      [293.66, 440.0, 587.33, 659.25],
      [196.0, 392.0, 493.88, 587.33],
      [220.0, 329.63, 440.0, 554.37],
      [246.94, 369.99, 440.0, 493.88],
    ],
    chordDur: 12,
    penta: [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66],
    plucks: 2,
    padGain: 0.02, bassGain: 0.02, pluckGain: 0.03,
    filter: 1400,
  },
  sweet: {
    name: "甜蜜温馨",
    chords: [
      [130.81, 196.0, 261.63, 329.63, 392.0],   // C
      [110.0, 164.81, 220.0, 261.63, 329.63],   // Am7
      [174.61, 220.0, 261.63, 349.23],          // F
      [196.0, 246.94, 293.66, 392.0],           // G
    ],
    chordDur: 8,
    penta: [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33],
    plucks: 4,
    padGain: 0.03, bassGain: 0.05, pluckGain: 0.055,
    filter: 1100,
  },
  zen: {
    name: "静夜禅意",
    chords: [
      [73.42, 110.0, 146.83],
      [55.0, 82.41, 110.0],
      [49.0, 73.42, 98.0],
      [82.41, 123.47, 164.81],
    ],
    chordDur: 18,
    penta: [146.83, 196.0, 220.0, 261.63, 293.66, 329.63],
    plucks: 1,
    padGain: 0.022, bassGain: 0.06, pluckGain: 0.03,
    filter: 700,
  },
};

function isNight() {
  const h = new Date().getHours();
  return h >= 22 || h < 6;
}

const Music = {
  ctx: null,
  master: null,
  playing: false,
  timer: null,
  chordIdx: 0,
  dayStyle: "ambient",
  nightStyle: "melancholy",
  nightMode: true,
  volume: 30,
  styleKey: "ambient",

  gainOf() {
    return 0.005 + (this.volume / 100) * 0.345;
  },

  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.gainOf();
    this.lp = this.ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 1000;
    this.master.connect(this.lp);
    this.lp.connect(this.ctx.destination);
    return true;
  },

  setVolume(v, ramp) {
    this.volume = Math.max(0, Math.min(100, v));
    if (this.master && this.ctx) {
      const g = this.master.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      if (ramp) {
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(this.gainOf(), t + 0.4);
      } else {
        g.value = this.gainOf();
      }
    }
  },

  setFilter(hz) {
    if (this.lp && this.ctx) {
      this.lp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.5);
    }
  },

  padNote(freq, t, dur, st) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(st.padGain, t + Math.min(2.2, dur * 0.25));
    g.gain.setValueAtTime(st.padGain, t + dur - Math.min(2.5, dur * 0.3));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3);
    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = freq;
    o1.detune.value = Math.random() * 6 - 3;
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(this.master);
    o1.start(t);
    o2.start(t);
    o1.stop(t + dur + 0.5);
    o2.stop(t + dur + 0.5);
  },

  bassNote(freq, t, dur, st) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(st.bassGain, t + Math.min(1.8, dur * 0.2));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.4);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.6);
  },

  pluckNote(freq, t, st) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(st.pluckGain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o.connect(g);
    if (pan) {
      pan.pan.value = Math.random() * 1.4 - 0.7;
      g.connect(pan);
      pan.connect(this.master);
    } else {
      g.connect(this.master);
    }
    o.start(t);
    o.stop(t + 3);
  },

  schedule() {
    if (!this.playing || !this.ctx) return;
    const st = MUSIC_STYLES[this.styleKey] || MUSIC_STYLES.ambient;
    this.setFilter(st.filter);
    const now = this.ctx.currentTime;
    const chord = st.chords[this.chordIdx % st.chords.length];
    const dur = st.chordDur;
    chord.forEach((f) => this.padNote(f, now, dur, st));
    this.bassNote(chord[0], now, dur, st);
    const step = (dur - 2) / st.plucks;
    for (let k = 0; k < st.plucks; k++) {
      const t = now + 1.5 + k * step + Math.random() * 1.1;
      this.pluckNote(st.penta[Math.floor(Math.random() * st.penta.length)], t, st);
    }
    this.chordIdx++;
    this.timer = setTimeout(() => this.schedule(), dur * 1000);
  },

  applyStyle(key) {
    key = MUSIC_STYLES[key] ? key : "ambient";
    if (key === this.styleKey && this.playing) return;
    this.styleKey = key;
    if (this.playing) {
      clearTimeout(this.timer);
      this.chordIdx = 0;
      this.schedule();
    }
  },

  refresh() {
    const key = this.nightMode && isNight() ? this.nightStyle : this.dayStyle;
    this.applyStyle(key);
  },

  start() {
    if (this.playing) return;
    if (!this.init()) return;
    this.refresh();
    this.playing = true;
    this.chordIdx = 0;
    this.schedule();
  },

  stop() {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.master) {
      const g = this.master.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(g.value, this.ctx.currentTime);
      g.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.8);
    }
  },
};

// 读取持久化偏好
Music.volume = parseInt(localStorage.getItem("wx_music_volume") || "30", 10);
Music.dayStyle = localStorage.getItem("wx_music_day") || "ambient";
Music.nightStyle = localStorage.getItem("wx_music_night") || "melancholy";
Music.nightMode = localStorage.getItem("wx_music_nightmode") !== "0";

/* ---------- 音乐面板 ---------- */

const musicBtn = $("#btn-music");
function refreshMusicBtn() {
  musicBtn.textContent = Music.playing ? "🎵 音乐：开" : "🎵 音乐";
  musicBtn.classList.toggle("on", Music.playing);
}

function renderPlayBtn() {
  $("#btn-music-play").textContent = Music.playing ? "⏸ 停止音乐" : "▶ 播放音乐";
}

function renderMusicNow() {
  const st = MUSIC_STYLES[Music.nightMode && isNight() ? Music.nightStyle : Music.dayStyle];
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  $("#m-now").textContent = `现在 ${hh}:${mm} · ${isNight() ? "🌙 夜晚时段" : "☀️ 白天时段"} · 生效：${st.name}`;
}

function openMusicPanel() {
  $("#m-volume").value = Music.volume;
  $("#m-vol-val").textContent = Music.volume + "%";
  $("#m-day-style").value = Music.dayStyle;
  $("#m-night-style").value = Music.nightStyle;
  $("#m-night-mode").checked = Music.nightMode;
  renderPlayBtn();
  renderMusicNow();
  $("#music-mask").classList.remove("hidden");
}

function closeMusicPanel() {
  $("#music-mask").classList.add("hidden");
}

musicBtn.addEventListener("click", openMusicPanel);

$("#btn-music-play").addEventListener("click", () => {
  if (!Music.playing) {
    Music.start();
    localStorage.setItem("wx_music_pref", "1");
  } else {
    Music.stop();
    localStorage.setItem("wx_music_pref", "0");
  }
  renderPlayBtn();
  refreshMusicBtn();
});

$("#m-volume").addEventListener("input", (e) => {
  const v = parseInt(e.target.value, 10);
  Music.setVolume(v, true);
  $("#m-vol-val").textContent = v + "%";
  localStorage.setItem("wx_music_volume", String(v));
});

$("#m-day-style").addEventListener("change", (e) => {
  Music.dayStyle = e.target.value;
  localStorage.setItem("wx_music_day", Music.dayStyle);
  Music.refresh();
  renderMusicNow();
});

$("#m-night-style").addEventListener("change", (e) => {
  Music.nightStyle = e.target.value;
  localStorage.setItem("wx_music_night", Music.nightStyle);
  Music.refresh();
  renderMusicNow();
});

$("#m-night-mode").addEventListener("change", (e) => {
  Music.nightMode = e.target.checked;
  localStorage.setItem("wx_music_nightmode", Music.nightMode ? "1" : "0");
  Music.refresh();
  renderMusicNow();
});

$("#btn-close-music").addEventListener("click", closeMusicPanel);
$("#music-mask").addEventListener("click", (e) => {
  if (e.target === $("#music-mask")) closeMusicPanel();
});

// 夜晚/白天切换实时监测（每 30 秒）
setInterval(() => {
  Music.refresh();
  if (!$("#music-mask").classList.contains("hidden")) renderMusicNow();
}, 30000);

// 记住偏好：上次开着音乐，本次进入页面后点击任意位置自动恢复
if (localStorage.getItem("wx_music_pref") === "1") {
  refreshMusicBtn();
  const tryResume = () => {
    if (!Music.playing && state) {
      Music.start();
      renderPlayBtn();
      refreshMusicBtn();
    }
  };
  document.addEventListener("click", tryResume, { once: true });
}

/* ================= 自动翻动（持续平滑滚动） ================= */

const AutoScroll = {
  on: false,
  raf: null,
  lastTs: 0,
  startedAt: 0,
  speed: parseFloat(localStorage.getItem("wx_auto_speed") || "40") || 40,

  atBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 4;
  },

  start() {
    if (this.on) return;
    // 已在底部（无历史可滚）时，自动回到开头，从头开始滚动重播
    if (this.atBottom()) {
      scrollEl.scrollTop = 0;
    }
    this.on = true;
    this.lastTs = 0;
    this.startedAt = performance.now();
    refreshAutoBtn();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  },

  loop(ts) {
    if (!this.on) return;
    if (this.lastTs) {
      const dt = Math.min((ts - this.lastTs) / 1000, 0.1); // 帧间隔上限，防切后台后猛跳
      scrollEl.scrollTop += this.speed * dt;
    }
    this.lastTs = ts;
    // 启动 1 秒内不做触底判断，避免误停
    if (ts - this.startedAt > 1000 && this.atBottom()) {
      this.stop(true);
      return;
    }
    this.raf = requestAnimationFrame((t) => this.loop(t));
  },

  stop(finished) {
    this.on = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    refreshAutoBtn();
  },
};

const autoBtn = $("#btn-auto");
function refreshAutoBtn() {
  autoBtn.textContent = AutoScroll.on ? "⏸ 停止翻动" : "▶ 自动翻动";
  autoBtn.classList.toggle("on", AutoScroll.on);
}
autoBtn.addEventListener("click", () => {
  if (AutoScroll.on) AutoScroll.stop(false);
  else AutoScroll.start();
});

$("#auto-speed").value = AutoScroll.speed;
$("#auto-speed-val").textContent = AutoScroll.speed + "px/秒";
$("#auto-speed").addEventListener("input", (e) => {
  AutoScroll.speed = parseFloat(e.target.value) || 40;
  $("#auto-speed-val").textContent = AutoScroll.speed + "px/秒";
  localStorage.setItem("wx_auto_speed", String(AutoScroll.speed));
});

// 手动滚动、翻页、跳转时自动暂停
scrollEl.addEventListener("wheel", () => {
  if (AutoScroll.on) AutoScroll.stop(false);
}, { passive: true });

/* ================= 语音朗读（TTS · 多角色配音 · Edge 神经语音） ================= */

const SelMode = { on: false, set: new Set() };

// 六种女声的声线键（与服务器 VOICE_CATALOG 对齐，f1~f6 机械映射）
const VOICE_PROFILES = {
  gentle: { label: "柔美" },
  sweet: { label: "清甜" },
  cold: { label: "冷艳" },
  warm: { label: "温婉" },
  lively: { label: "俏皮" },
  mature: { label: "御姐" },
};
const PROFILE_KEYS = Object.keys(VOICE_PROFILES);

// 可选神经语音列表（与服务器 VOICE_CATALOG 同步）
const EDGE_VOICES = [
  ["zh-CN-XiaoxiaoNeural", "晓晓 · 温柔女声"],
  ["zh-CN-XiaoyiNeural", "晓伊 · 活泼女声"],
  ["zh-CN-XiaobeiNeural", "晓北 · 东北女声"],
  ["zh-CN-XiaoniNeural", "晓妮 · 陕西女声"],
  ["zh-TW-HsiaoChenNeural", "曉辰 · 台湾女声"],
  ["zh-HK-HiuMaanNeural", "曉曼 · 粤语女声"],
  ["zh-CN-YunxiNeural", "云希 · 温柔男声"],
  ["zh-CN-YunjianNeural", "云健 · 浑厚男声"],
  ["zh-CN-YunyangNeural", "云扬 · 沉稳男声"],
  ["zh-CN-YunxiaNeural", "云夏 · 少年男声"],
];

// 世界角色数据（AI 识别）：{wid: {names: {名字: 性别}, map: {名字: 声线key}}}
function loadCharData(wid) {
  try {
    const all = JSON.parse(localStorage.getItem("wx_char_data") || "{}");
    return (all && all[wid]) || null;
  } catch (e) {
    return null;
  }
}
function saveCharData(wid, data) {
  try {
    const all = JSON.parse(localStorage.getItem("wx_char_data") || "{}");
    all[wid] = data;
    localStorage.setItem("wx_char_data", JSON.stringify(all));
  } catch (e) {}
}
function clearCharData(wid) {
  try {
    const all = JSON.parse(localStorage.getItem("wx_char_data") || "{}");
    delete all[wid];
    localStorage.setItem("wx_char_data", JSON.stringify(all));
  } catch (e) {}
}
function currentWorldId() {
  return (state && state.current && state.current.profile && state.current.profile.id) || "";
}

function analyzeCharacters(force) {
  const wid = currentWorldId();
  if (!wid) return;
  if (!force && loadCharData(wid)) return;
  call({ action: "char_voices" }).then((s) => {
    if (s.assist && s.assist.field === "char_voices") {
      const chars = s.assist.characters || [];
      const names = {};
      chars.forEach((c) => {
        if (c.name) names[c.name] = c.gender || "女";
      });
      const females = Object.keys(names).filter((n) => names[n] === "女");
      const map = {};
      females.forEach((name, i) => {
        map[name] = PROFILE_KEYS[i % PROFILE_KEYS.length];
      });
      saveCharData(wid, { names, map });
      TTS.clearCache();
      renderCharList();
    }
  }).catch(() => {});
}

function renderCharList() {
  const el = $("#s-char-list");
  if (!el) return;
  const wid = currentWorldId();
  const data = wid ? loadCharData(wid) : null;
  if (!data || !Object.keys(data.names || {}).length) {
    el.textContent = "进入世界后自动识别角色名字；若档案修改过，可点下方按钮重新识别。";
    return;
  }
  const parts = Object.keys(data.names).map((n) => {
    const prof = (data.map && data.map[n] && VOICE_PROFILES[data.map[n]]) ? VOICE_PROFILES[data.map[n]].label : "默认";
    return n + "（" + data.names[n] + "·" + prof + "）";
  });
  el.textContent = "已识别：" + parts.join("、");
}

// 角色 → 声线槽位（机械映射，保证不同角色必然不同声线）
function roleSlot(role) {
  if (role === "旁白") return "narrator";
  if (role === "男主") return "male1";
  if (role === "男配") return "male2";
  if (role === "女配") return "female_other";
  const mw = /^女主(\d+)$/.exec(role);
  if (mw) return "f" + Math.min(parseInt(mw[1], 10), 6);
  const wid = currentWorldId();
  const data = wid ? loadCharData(wid) : null;
  if (data && data.map && data.map[role]) {
    const idx = PROFILE_KEYS.indexOf(data.map[role]);
    if (idx >= 0) return "f" + Math.min(idx + 1, 6);
  }
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0;
  return "f" + ((h % 6) + 1);
}

function cleanForSpeech(text) {
  let s = String(text);
  // 状态块与行动选项不朗读：从最早的标记开始全部截掉
  let cut = s.length;
  ["【世界状态】", "【行动选项】"].forEach((mk) => {
    const i = s.indexOf(mk);
    if (i > 0 && i < cut) cut = i;
  });
  if (cut < s.length) s = s.slice(0, cut);
  return s
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^[⚠✦💾▶✨🎭🔊⏸⏹☑🎨💡📌]/.test(t)) return false;
      if (/^[（(【][^）)】]{0,60}[）)】]$/.test(t)) return false;
      return true;
    })
    .join("\n");
}

const TTS = {
  enabled: localStorage.getItem("wx_tts_on") === "1",
  mode: localStorage.getItem("wx_tts_mode") || "normal",
  queue: [],
  cache: new Map(),
  msgIdx: 0,
  segIdx: 0,
  sentIdx: 0,
  paused: false,
  active: false,
  preparing: false,
  audio: null,
  _prefetched: [],

  zhVoices() {
    try {
      return speechSynthesis.getVoices().filter((v) => /zh|Chinese/i.test(v.lang + " " + v.name));
    } catch (e) {
      return [];
    }
  },

  pickBest() {
    const zh = this.zhVoices();
    if (!zh.length) return null;
    const prefer = ["Xiaoxiao", "晓晓", "Xiaoyi", "晓伊", "Huihui", "慧慧", "Yaoyao", "瑶瑶"];
    for (const p of prefer) {
      const hit = zh.find((v) => v.name.toLowerCase().includes(p.toLowerCase()));
      if (hit) return hit;
    }
    return zh[0];
  },

  sentences(text) {
    return String(text).split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
  },

  cacheKey(item) {
    if (typeof item.idx === "number") return item.idx;
    const t = String(item.text || "");
    return "t" + t.length + t.slice(0, 16);
  },

  speak(text) {
    this.playQueue([{ text }]);
  },

  playQueue(items) {
    const q = (items || []).filter((x) => x && x.text);
    if (!q.length) {
      addSys("⚠ 没有可朗读的内容（先去选择消息吧）");
      return;
    }
    this.stopAudio();
    this.queue = q;
    this.msgIdx = 0;
    this.segIdx = 0;
    this.sentIdx = 0;
    this.paused = false;
    this.active = true;
    this.preparing = false;
    this.ensureAndSpeak();
  },

  ensureAndSpeak() {
    if (!this.active || this.paused) {
      updatePlayerBar();
      return;
    }
    if (this.msgIdx >= this.queue.length) {
      this.stop();
      return;
    }
    // 一般模式：逐句流式播放（首句约1.5秒出声 + 后台预取下一句无缝衔接）
    if (this.mode === "normal") {
      const item = this.queue[this.msgIdx];
      if (!item.sents) {
        item.sents = this.sentences(cleanForSpeech(item.text));
      }
      this.speakNormal(item);
      return;
    }
    const item = this.queue[this.msgIdx];
    const key = this.cacheKey(item);
    if (item.segments) {
      this.speakSegments();
      return;
    }
    if (this.cache.has(key)) {
      item.segments = this.cache.get(key);
      this.speakSegments();
      return;
    }
    this.preparing = true;
    updatePlayerBar();
    fetchSplit(item.text)
      .then((segs) => {
        item.segments = segs;
        this.cache.set(key, segs);
        this.preparing = false;
        if (this.active && !this.paused) this.speakSegments();
        updatePlayerBar();
      })
      .catch(() => {
        item.segments = [{ role: "旁白", slot: "narrator", text: item.text }];
        this.cache.set(key, item.segments);
        this.preparing = false;
        if (this.active && !this.paused) this.speakSegments();
        updatePlayerBar();
      });
  },

  speakSegments() {
    if (!this.active || this.paused) {
      updatePlayerBar();
      return;
    }
    const item = this.queue[this.msgIdx];
    const segs = item.segments || [{ role: "旁白", slot: "narrator", text: item.text }];
    if (this.segIdx >= segs.length) {
      this.msgIdx++;
      this.segIdx = 0;
      this.sentIdx = 0;
      this.prefetchNext();
      this.ensureAndSpeak();
      return;
    }
    const seg = segs[this.segIdx];
    const sents = this.sentences(cleanForSpeech(seg.text));
    if (this.sentIdx >= sents.length) {
      this.segIdx++;
      this.sentIdx = 0;
      this.speakSegments();
      return;
    }
    const slot = seg.slot || roleSlot(seg.role);
    const sent = sents[this.sentIdx];
    this.highlightCurrent();
    updatePlayerBar();
    this.playAudio(sent, slot, () => {
      if (this.active && !this.paused) {
        this.sentIdx++;
        this.speakSegments();
      }
    });
  },

  playAudio(text, slot, onend) {
    this.stopAudio();
    const url = "/api/tts?text=" + encodeURIComponent(text) + "&slot=" + encodeURIComponent(slot) +
      "&code=" + encodeURIComponent(wxCode);
    const a = new Audio(url);
    this.audio = a;
    a.preload = "auto";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (onend) onend();
    };
    a.onended = finish;
    a.onerror = () => {
      if (settled) return;
      settled = true;
      this.fallbackSpeak(text);
      finish();
    };
    const pr = a.play();
    if (pr && pr.catch) pr.catch(() => {});
  },

  speakNormal(item) {
    if (!this.active || this.paused) {
      updatePlayerBar();
      return;
    }
    const sents = item.sents || [];
    if (this.sentIdx >= sents.length) {
      this.msgIdx++;
      this.sentIdx = 0;
      this.ensureAndSpeak();
      return;
    }
    const sent = sents[this.sentIdx];
    this.highlightCurrent();
    updatePlayerBar();
    this.playAudio(sent, "main", () => {
      if (this.active && !this.paused) {
        this.sentIdx++;
        this.speakNormal(item);
      }
    });
    // 当前句播放时后台合成下一句，实现无缝衔接
    const next = sents[this.sentIdx + 1];
    if (next) this.prefetchAudio(next, "main");
  },

  prefetchAudio(text, slot) {
    try {
      const url = "/api/tts?text=" + encodeURIComponent(text) + "&slot=" + encodeURIComponent(slot) +
        "&code=" + encodeURIComponent(wxCode);
      const a = new Audio(url);
      a.preload = "auto";
      this._prefetched.push(a);
      if (this._prefetched.length > 6) this._prefetched.shift();
    } catch (e) {}
  },

  fallbackSpeak(text) {
    try {
      if (!("speechSynthesis" in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickBest();
      if (v) u.voice = v;
      u.lang = "zh-CN";
      speechSynthesis.speak(u);
    } catch (e) {}
  },

  prefetchNext() {
    const next = this.queue[this.msgIdx];
    if (next && !next.segments) {
      const key = this.cacheKey(next);
      if (!this.cache.has(key)) {
        fetchSplit(next.text).then((segs) => {
          this.cache.set(key, segs);
        }).catch(() => {});
      }
    }
  },

  pause() {
    if (!this.active) return;
    this.paused = true;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch (e) {}
    }
    updatePlayerBar();
  },

  resume() {
    if (!this.active) return;
    this.paused = false;
    if (this.audio) {
      const pr = this.audio.play();
      if (pr && pr.catch) pr.catch(() => {});
      updatePlayerBar();
    } else {
      this.speakSegments();
    }
  },

  stop() {
    this.stopAudio();
    try {
      speechSynthesis.cancel();
    } catch (e) {}
    this.active = false;
    this.paused = false;
    this.preparing = false;
    this.queue = [];
    this.msgIdx = 0;
    this.segIdx = 0;
    this.sentIdx = 0;
    this.clearHighlight();
    updatePlayerBar();
  },

  stopAudio() {
    if (this.audio) {
      try {
        this.audio.pause();
      } catch (e) {}
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }
  },

  clearCache() {
    this.cache.clear();
  },

  highlightCurrent() {
    this.clearHighlight();
    const item = this.queue[this.msgIdx];
    if (item && item.el) {
      item.el.classList.add("reading");
      item.el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  },

  clearHighlight() {
    document.querySelectorAll(".msg.reading").forEach((e) => e.classList.remove("reading"));
  },
};

function fetchSplit(text) {
  const wid = currentWorldId();
  const data = wid ? loadCharData(wid) : null;
  const names = (data && data.names) || {};
  const females = Object.keys(names).filter((n) => names[n] === "女");
  const males = Object.keys(names).filter((n) => names[n] === "男");
  return call({ action: "tts_split", text, females, males }).then((s) => {
    if (s.error) throw new Error(s.error);
    if (s.assist && s.assist.field === "tts_split" && s.assist.segments) return s.assist.segments;
    return [{ role: "旁白", slot: "narrator", text }];
  });
}

function updatePlayerBar() {
  const playBtn = $("#btn-tts-play");
  const stopBtn = $("#btn-tts-stop");
  const selBtn = $("#btn-tts-select");
  const bar = $("#tts-progress");
  if (TTS.preparing) {
    playBtn.textContent = "…";
    playBtn.classList.add("on");
    playBtn.title = "AI 正在识别角色、分配声线……";
    stopBtn.disabled = false;
    bar.classList.remove("hidden");
    bar.style.width = "6%";
  } else if (TTS.active) {
    playBtn.textContent = TTS.paused ? "▶" : "⏸";
    playBtn.classList.add("on");
    playBtn.title = TTS.paused ? "继续朗读" : "暂停朗读";
    stopBtn.disabled = false;
    const total = TTS.queue.length || 1;
    const p = Math.min(100, ((TTS.msgIdx + (TTS.sentIdx > 0 ? 0.5 : 0)) / total) * 100);
    bar.classList.remove("hidden");
    bar.style.width = Math.max(2, p) + "%";
  } else {
    playBtn.textContent = "🔊";
    playBtn.classList.remove("on");
    playBtn.title = SelMode.set.size ? "连播所选消息（多角色配音）" : "从头朗读全文（多角色配音）";
    stopBtn.disabled = true;
    bar.classList.add("hidden");
    bar.style.width = "0%";
  }
  selBtn.textContent = SelMode.set.size ? "☑" + SelMode.set.size : "☑";
  selBtn.classList.toggle("on", SelMode.on);
  selBtn.title = SelMode.on
    ? "退出连播选择"
    : "连播选择：点击消息勾选，再点🔊连播";
}

function textPlaylist(onlySelected) {
  const items = [];
  renderedMsgs.forEach((m) => {
    if (m.role === "image") return;
    if (m.role !== "user" && m.role !== "assistant") return;
    if (onlySelected && !SelMode.set.has(m.idx)) return;
    items.push({ text: m.content, el: m.el, idx: m.idx, segments: m.segments });
  });
  return items;
}

// 播放器控制（内联于输入行）
$("#btn-tts-play").addEventListener("click", () => {
  if (TTS.active && TTS.paused) {
    TTS.resume();
    return;
  }
  if (TTS.active) {
    TTS.pause();
    return;
  }
  const onlySelected = SelMode.set.size > 0;
  TTS.playQueue(textPlaylist(onlySelected));
});
$("#btn-tts-stop").addEventListener("click", () => TTS.stop());
$("#btn-tts-select").addEventListener("click", () => {
  SelMode.on = !SelMode.on;
  if (!SelMode.on) {
    SelMode.set.clear();
    document.querySelectorAll(".msg.selected").forEach((e) => e.classList.remove("selected"));
  }
  updatePlayerBar();
});

// 声线设置面板（服务器端合成参数）
const VC_LABELS = {
  main: "默认朗读声线", gentle: "柔美", sweet: "清甜", cold: "冷艳", warm: "温婉",
  lively: "俏皮", mature: "御姐", narrator: "旁白", male1: "男主角", male2: "男配角",
};
let ttsSaveTimer = null;

function buildVoiceCastGrid(specs) {
  const box = $("#voice-cast-grid");
  if (!box) return;
  box.innerHTML = "";
  // 兼容服务器传来的两种格式：数组 [{key,...}] 或对象 {key: {...}}
  let list = [];
  if (Array.isArray(specs)) {
    list = specs;
  } else if (specs && typeof specs === "object") {
    list = Object.keys(specs).map((k) => {
      const v = specs[k] || {};
      return Object.assign({}, v, { key: k });
    });
  }
  list.forEach((row) => {
    if (!row || !row.key) return;
    const key = row.key;
    const r = document.createElement("div");
    r.className = "vc-row";
    r.dataset.key = key;
    const nameEl = document.createElement("span");
    nameEl.className = "vc-name";
    nameEl.textContent = VC_LABELS[key] || key;
    const sel = document.createElement("select");
    EDGE_VOICES.forEach(([v, t]) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = t;
      sel.appendChild(opt);
    });
    sel.value = EDGE_VOICES.some(([v]) => v === row.voice) ? row.voice : EDGE_VOICES[0][0];
    const pitchVal = parseInt(String(row.pitch || "").replace(/[^-\d]/g, ""), 10) || 0;
    const rateVal = parseInt(String(row.rate || "").replace(/[^-\d]/g, ""), 10) || 0;
    const pitch = document.createElement("input");
    pitch.type = "range";
    pitch.min = "-30"; pitch.max = "30"; pitch.step = "5";
    pitch.value = Math.max(-30, Math.min(30, pitchVal));
    pitch.title = "音调";
    const rate = document.createElement("input");
    rate.type = "range";
    rate.min = "-30"; rate.max = "30"; rate.step = "5";
    rate.value = Math.max(-30, Math.min(30, rateVal));
    rate.title = "语速";
    const note = document.createElement("span");
    note.className = "vc-note";
    const showNote = () => {
      note.textContent = "调" + pitch.value + "Hz / 速" + rate.value + "%";
    };
    showNote();
    const scheduleSave = () => {
      clearTimeout(ttsSaveTimer);
      ttsSaveTimer = setTimeout(saveVoiceCast, 700);
    };
    sel.onchange = scheduleSave;
    pitch.oninput = () => {
      showNote();
      scheduleSave();
    };
    rate.oninput = () => {
      showNote();
      scheduleSave();
    };
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "vc-play";
    playBtn.textContent = "▶ 试播";
    playBtn.title = "用当前语音/音调/语速试听";
    playBtn.onclick = () => previewVoice(key, sel.value, pitch.value, rate.value);
    r.appendChild(nameEl);
    r.appendChild(sel);
    r.appendChild(pitch);
    r.appendChild(rate);
    r.appendChild(playBtn);
    r.appendChild(note);
    box.appendChild(r);
  });
}

let previewAudio = null;
function fmtHz(v) {
  v = parseInt(v, 10) || 0;
  return (v >= 0 ? "+" : "") + v + "Hz";
}
function fmtPct(v) {
  v = parseInt(v, 10) || 0;
  return (v >= 0 ? "+" : "") + v + "%";
}
function previewVoice(key, voice, pitchVal, rateVal) {
  if (TTS.active) TTS.stop();
  if (previewAudio) {
    try {
      previewAudio.pause();
    } catch (e) {}
    previewAudio = null;
  }
  const text = "你好，我是" + (VC_LABELS[key] || "配音") + "声线。";
  const url = "/api/tts?text=" + encodeURIComponent(text) +
    "&slot=" + encodeURIComponent(key) +
    "&voice=" + encodeURIComponent(voice || "") +
    "&rate=" + encodeURIComponent(fmtPct(rateVal)) +
    "&pitch=" + encodeURIComponent(fmtHz(pitchVal)) +
    "&code=" + encodeURIComponent(wxCode);
  const a = new Audio(url);
  previewAudio = a;
  a.onended = () => {
    previewAudio = null;
  };
  a.onerror = () => {
    previewAudio = null;
    addSys("⚠ 试播失败，请检查网络");
  };
  const pr = a.play();
  if (pr && pr.catch) pr.catch(() => {});
}

function collectVoiceCast() {
  const out = {};
  document.querySelectorAll("#voice-cast-grid .vc-row").forEach((r) => {
    const sel = r.querySelector("select");
    const inputs = r.querySelectorAll("input[type=range]");
    out[r.dataset.key] = {
      voice: sel.value,
      pitch: fmtHz(inputs[0].value),
      rate: fmtPct(inputs[1].value),
    };
  });
  return out;
}

function saveVoiceCast() {
  const out = collectVoiceCast();
  if (!Object.keys(out).length) return;
  post({ action: "tts_voices_save", tts_voices: out }, { noTyping: true });
}

$("#btn-char-refresh").addEventListener("click", () => {
  const wid = currentWorldId();
  if (wid) clearCharData(wid);
  analyzeCharacters(true);
});

updatePlayerBar();
/* ================= 输入弹窗（重命名等） ================= */

let promptCb = null;
function promptDialog(title, placeholder, value, cb) {
  $("#prompt-title").textContent = title;
  $("#prompt-input").placeholder = placeholder || "";
  $("#prompt-input").value = value || "";
  promptCb = cb;
  $("#prompt-mask").classList.remove("hidden");
  setTimeout(() => $("#prompt-input").focus(), 60);
}
$("#prompt-ok").addEventListener("click", () => {
  const v = $("#prompt-input").value.trim();
  $("#prompt-mask").classList.add("hidden");
  const cb = promptCb;
  promptCb = null;
  if (cb && v) cb(v);
});
$("#prompt-cancel").addEventListener("click", () => {
  $("#prompt-mask").classList.add("hidden");
  promptCb = null;
});
$("#prompt-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#prompt-ok").click();
});

updatePlayerBar();

/* ================= 访问码（手机远程访问） ================= */

function showPinOverlay() {
  $("#pin-mask").classList.remove("hidden");
  setTimeout(() => $("#pin-input").focus(), 60);
}

$("#pin-ok").addEventListener("click", () => {
  const c = $("#pin-input").value.trim();
  if (!c) return;
  fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WX-Code": c, "X-WX-Device": deviceId() },
    body: JSON.stringify({ action: "state" }),
  })
    .then((r) => r.json())
    .then((s) => {
      if (s && s.error === "need_code") {
        $("#pin-input").value = "";
        $("#pin-sub").textContent = "❌ 访问码不对，请重新输入。";
      } else {
        wxCode = c;
        localStorage.setItem("wx_code", c);
        $("#pin-mask").classList.add("hidden");
        applyState(s);
      }
    })
    .catch(() => {
      $("#pin-sub").textContent = "⚠ 连接失败，请检查网络后重试。";
    });
});
$("#pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#pin-ok").click();
});

// 注册 Service Worker（手机"添加到主屏幕"用）
if ("serviceWorker" in navigator) {
  try {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  } catch (e) {}
}

/* ================= 启动 ================= */

function bootHide() {
  const el = document.getElementById("boot-loading");
  if (el) el.remove();
}
function bootFail(msg) {
  const el = document.getElementById("boot-msg");
  if (el) {
    el.textContent = msg;
    el.style.color = "#b8564a";
  }
}

post({ action: "state" }, { noTyping: true })
  .then(() => bootHide())
  .catch((e) => {
    bootFail("⚠ 连接服务器失败：" + e.message + "\n请确认网络正常后刷新本页（Mac 按 ⌘+Shift+R 强制刷新）。若长时间打不开，可能是服务器正在唤醒，等 60 秒再刷新。");
  });
// 双保险：界面渲染成功后也隐藏连接层
const _origApply = applyState;
applyState = function (s) {
  _origApply(s);
  bootHide();
};
