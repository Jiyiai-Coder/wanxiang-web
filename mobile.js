/* 万象幻境 · 手机竖屏版逻辑（与桌面版共用同一套后端与本地存档） */

const $ = (s) => document.querySelector(s);
let wxCode = localStorage.getItem("wx_code") || "";
let state = null;
let renderedCount = 0;
let busy = false;
let lastErrorShown = "";

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
  if (s && s.error === "need_code") showPin();
  return s;
}

function showScreen(name) {
  ["pin", "worlds", "game", "wizard", "settings"].forEach((n) => {
    $("#" + n).classList.toggle("hidden", n !== name);
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add("hidden"), 2600);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function setBusy(b) {
  busy = b;
  $("#send").disabled = b;
  $("#typing").classList.toggle("hidden", !b);
}

/* ================= 本机存档（与桌面版共用同一份浏览器存档） ================= */

let wxLocalRestored = false;
let wxDumpTimer = null;
function wxLocalSave() {
  try { return JSON.parse(localStorage.getItem("wx_local_save") || "null"); }
  catch (e) { return null; }
}
function wxLocalStore(blob) {
  try {
    localStorage.setItem("wx_local_save", JSON.stringify(blob));
    const h = $("#save-hint");
    if (h) h.textContent = "💾 已存本机 " + new Date().toTimeString().slice(0, 5);
  } catch (e) {}
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

/* ================= 状态应用 ================= */

function applyState(s) {
  bootHide();
  state = s;
  if (s.error && s.error !== lastErrorShown) {
    lastErrorShown = s.error;
    toast("⚠ " + s.error);
  }
  if (s.assist && s.assist.field === "dump_all") {
    wxLocalStore(s.assist);
    return;
  }
  wxMaybeRestore(s);
  if (["say", "start", "world_create", "world_delete", "world_edit",
       "delete_msg", "regenerate", "restart"].includes(s.op)) {
    wxScheduleDump();
  }
  if (s.mode === "worlds") {
    showScreen("worlds");
    renderWorlds(s);
    return;
  }
  showScreen("game");
  renderGame(s);
}

/* ================= 世界列表 ================= */

function renderWorlds(s) {
  const box = $("#world-list");
  box.innerHTML = "";
  const list = s.worlds || [];
  $("#worlds-hint").classList.toggle("hidden", list.length > 0);
  list.forEach((w) => {
    const card = document.createElement("div");
    card.className = "w-card";
    card.innerHTML =
      '<div class="w-name">' + escapeHtml(w.name) + '</div>' +
      '<div class="w-desc">' + escapeHtml(w.desc || "（未填写简介）") + '</div>' +
      '<div class="w-meta">' + (w.count || 0) + " 条消息 · 点击进入</div>" +
      '<button class="w-del" title="删除">🗑</button>';
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("w-del")) return;
      call({ action: "world_open", id: w.id }).then(applyState).catch((er) => toast("⚠ " + er.message));
    });
    card.querySelector(".w-del").addEventListener("click", () => {
      if (!confirm("确定删除「" + w.name + "」吗？此操作无法撤销。")) return;
      call({ action: "world_delete", id: w.id }).then(applyState).catch((er) => toast("⚠ " + er.message));
    });
    box.appendChild(card);
  });
}

/* ================= 游戏界面 ================= */

function parseBlocks(text) {
  let body = text || "";
  let status = "";
  let opts = [];
  const si = body.indexOf("【世界状态】");
  const oi = body.indexOf("【行动选项】");
  const segs = [si, oi].filter((x) => x >= 0);
  const first = segs.length ? Math.min(...segs) : -1;
  if (first >= 0) {
    status = body.slice(first);
    body = body.slice(0, first);
  }
  if (status) {
    const k = status.indexOf("【行动选项】");
    if (k >= 0) {
      const optTxt = status.slice(k);
      status = status.slice(0, k);
      (optTxt.split("\n")).forEach((l) => {
        const m = l.match(/^\s*\d+[.、）]\s*(.+)/);
        if (m) opts.push(m[1].trim());
      });
    }
  }
  return { body: body.trim(), status: status.trim(), opts };
}

function renderGame(s) {
  const cur = s.current || {};
  $("#g-title").textContent = (cur.profile && cur.profile.name) || "万象幻境";
  const hist = cur.history || [];
  const log = $("#log");
  if (hist.length < renderedCount) {
    log.innerHTML = "";
    renderedCount = 0;
  }
  for (let i = renderedCount; i < hist.length; i++) appendMsg(hist[i], i);
  renderedCount = hist.length;
  // 新世界空历史 → 显示开始按钮
  let startBtn = $("#start-btn");
  if (!hist.length && !startBtn) {
    startBtn = document.createElement("button");
    startBtn.id = "start-btn";
    startBtn.className = "big-btn";
    startBtn.style.width = "86%";
    startBtn.style.margin = "16px auto";
    startBtn.textContent = "✨ 开始这个世界";
    startBtn.addEventListener("click", () => {
      call({ action: "start" }).then(applyState).catch((er) => toast("⚠ " + er.message));
    });
    log.appendChild(startBtn);
  }
  if (hist.length && startBtn) startBtn.remove();
  log.scrollTop = log.scrollHeight;
  setBusy(false);
}

function appendMsg(m, idx) {
  const log = $("#log");
  const d = document.createElement("div");
  d.className = "msg " + (m.role === "assistant" ? "ai" : "me");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "assistant" ? "万象" : "";
  d.appendChild(who);
  const b = document.createElement("div");
  b.className = "bubble";

  const { body, status, opts } = parseBlocks(m.content);
  const t = document.createElement("div");
  t.textContent = body;
  b.appendChild(t);

  if (status) {
    const det = document.createElement("details");
    det.className = "status-card";
    const sum = document.createElement("summary");
    sum.textContent = "📊 世界状态";
    const sb = document.createElement("div");
    sb.className = "st-body";
    sb.textContent = status.replace("【世界状态】", "").trim();
    det.appendChild(sum);
    det.appendChild(sb);
    b.appendChild(det);
  }
  if (opts.length) {
    const ob = document.createElement("div");
    ob.className = "opt-box";
    opts.forEach((o) => {
      const btn = document.createElement("button");
      btn.className = "opt-btn";
      btn.textContent = o;
      btn.addEventListener("click", () => sendText(o));
      ob.appendChild(btn);
    });
    b.appendChild(ob);
  }

  // 助手消息：换种说法 + 删除
  if (m.role === "assistant") {
    const tools = document.createElement("div");
    tools.className = "tools";
    const reg = document.createElement("button");
    reg.textContent = "↻ 换种说法";
    reg.addEventListener("click", () => {
      setBusy(true);
      call({ action: "regenerate" }).then(applyState).catch((er) => { toast("⚠ " + er.message); setBusy(false); });
    });
    const del = document.createElement("button");
    del.textContent = "🗑 删除";
    del.addEventListener("click", () => {
      if (!confirm("只删除这一条消息，确定吗？")) return;
      call({ action: "delete_msg", index: idx }).then(applyState).catch((er) => toast("⚠ " + er.message));
    });
    tools.appendChild(reg);
    tools.appendChild(del);
    b.appendChild(tools);
  }
  d.appendChild(b);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function sendText(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  setBusy(true);
  $("#tin").value = "";
  $("#tin").style.height = "auto";
  call({ action: "say", text })
    .then(applyState)
    .catch((er) => { toast("⚠ " + er.message); setBusy(false); });
}

/* ================= 向导 ================= */

const DEFAULT_PROFILE = () => ({
  realism: $("#w-realism").value || "3",
  output_len: $("#w-len").value || "2",
  show_status: "1",
  status_detail: $("#w-status-detail").value || "1",
  options_on: "1",
  options_count: "3",
  options_len: "2",
});

function collectDraft() {
  return {
    name: $("#w-name").value.trim(),
    desc: $("#w-desc").value.trim(),
    world: $("#w-world").value.trim(),
    protagonist: $("#w-protagonist").value.trim(),
    characters: $("#w-characters").value.trim(),
    style: $("#w-style").value.trim(),
    rules: $("#w-rules").value.trim(),
  };
}

function fillDraft(p) {
  if (!p) return;
  ["world", "protagonist", "characters", "style", "rules"].forEach((k) => {
    if (p[k]) $("#w-" + k).value = p[k];
  });
  if (p.realism) $("#w-realism").value = p.realism;
  if (p.output_len) $("#w-len").value = p.output_len;
  if (p.status_detail) $("#w-status-detail").value = p.status_detail;
}

$("#w-gen").addEventListener("click", () => {
  const draft = collectDraft();
  if (!draft.name) { toast("请先填写世界名称"); return; }
  const btn = $("#w-gen");
  btn.disabled = true;
  btn.textContent = "⏳ 生成中……（约 30 秒）";
  call({ action: "ai_assist", field: "all", draft })
    .then((s) => {
      btn.disabled = false;
      btn.textContent = "✨ 一键生成完整世界观";
      if (s.assist && s.assist.profile) {
        fillDraft(s.assist.profile);
        $("#w-adv").open = true;
        toast("✔ 世界观已生成，可修改后点「创建并开始」");
      } else {
        toast("⚠ 生成失败，请检查接口设置");
      }
    })
    .catch((er) => {
      btn.disabled = false;
      btn.textContent = "✨ 一键生成完整世界观";
      toast("⚠ " + er.message);
    });
});

$("#w-create").addEventListener("click", () => {
  const d = collectDraft();
  if (!d.name) { toast("请先填写世界名称"); return; }
  if (!d.desc) { toast("请写一句简介（你的身份与目标）"); return; }
  const profile = Object.assign({}, d, DEFAULT_PROFILE());
  const btn = $("#w-create");
  btn.disabled = true;
  btn.textContent = "⏳ 创建中……";
  call({ action: "world_create", profile })
    .then(() => {
      btn.textContent = "⏳ 万象正在书写开篇……";
      return call({ action: "start" });
    })
    .then(applyState)
    .catch((er) => {
      btn.disabled = false;
      btn.textContent = "🚀 创建并开始";
      toast("⚠ " + er.message);
    });
});

/* ================= 设置 ================= */

const PROVIDER_MODELS = {
  deepseek: [["deepseek-v4-pro", "DeepSeek-V4-Pro（强）"], ["deepseek-flash", "DeepSeek-V4.1-Flash（快·便宜）"]],
  zhipu: [["glm-4-flash", "GLM-4-Flash（永久免费）"], ["glm-4-plus", "GLM-4-Plus"], ["glm-4-air", "GLM-4-Air"]],
  siliconflow: [["deepseek-ai/DeepSeek-V3", "DeepSeek-V3"], ["deepseek-ai/DeepSeek-R1", "DeepSeek-R1"]],
  openrouter: [["deepseek/deepseek-v4-flash:free", "DeepSeek V4.1-Flash（免费）"], ["deepseek/deepseek-v4-pro", "DeepSeek V4-Pro"]],
  modelscope: [["deepseek-ai/DeepSeek-V3.1", "DeepSeek-V3.1"], ["Qwen/Qwen2.5-7B-Instruct", "Qwen2.5-7B"]],
  kimi: [["moonshot-v1-8k", "moonshot-v1-8k"], ["moonshot-v1-32k", "moonshot-v1-32k"]],
  qwen: [["qwen-plus", "qwen-plus"], ["qwen-max", "qwen-max"]],
  openai: [["gpt-4o-mini", "gpt-4o-mini"], ["gpt-4o", "gpt-4o"]],
  default: [["deepseek-v4-pro", "DeepSeek-V4-Pro"], ["deepseek-flash", "DeepSeek-V4.1-Flash"]],
};

function modelOptions(pid, current) {
  const list = (PROVIDER_MODELS[pid] || PROVIDER_MODELS.default).slice();
  if (current && !list.some((x) => x[0] === current)) list.push([current, "当前：" + current]);
  return list.map(([v, l]) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(l) + "</option>").join("") +
    '<option value="__custom__">✍ 自定义</option>';
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

function renderSettings(s) {
  const provs = s.providers || {};
  const active = s.active_text || "";
  const sel = $("#s-active");
  sel.innerHTML = "";
  Object.keys(provs).forEach((pid) => {
    const o = document.createElement("option");
    o.value = pid;
    o.textContent = provs[pid].name + (provs[pid].api_key ? " ✓" : "（未填密钥）");
    sel.appendChild(o);
  });
  sel.value = active;

  const box = $("#s-cards");
  box.innerHTML = "";
  Object.keys(provs).forEach((pid) => {
    const p = provs[pid];
    const card = document.createElement("div");
    card.className = "p-card";
    card.dataset.pid = pid;
    card.innerHTML =
      '<div class="p-name">' + escapeHtml(p.name || pid) + "</div>" +
      '<input type="hidden" data-k="name" value="' + escapeHtml(p.name || pid) + '">' +
      '<div class="p-field">接口地址</div>' +
      '<input data-k="base_url" value="' + escapeHtml(p.base_url || "") + '" placeholder="https://…">' +
      '<div class="p-field">API Key（你自己的密钥）</div>' +
      '<input type="password" data-k="api_key" value="' + escapeHtml(p.api_key || "") + '" placeholder="sk-…">' +
      '<div class="p-field">对话模型</div>' +
      '<select data-k="model">' + modelOptions(pid, p.model || "") + "</select>" +
      '<input data-k="model_custom" class="hidden" placeholder="自定义模型 ID">' +
      '<div class="p-btns">' +
      '<button class="p-test" type="button">🔍 测试连接</button>' +
      '<button class="p-getmodels" type="button">📋 获取模型</button>' +
      "</div>" +
      '<div class="p-test-result"></div>';
    box.appendChild(card);
    const msel = card.querySelector('[data-k="model"]');
    if (msel && p.model) msel.value = p.model;
    const cu = card.querySelector('[data-k="model_custom"]');
    msel.addEventListener("change", () => {
      cu.classList.toggle("hidden", msel.value !== "__custom__");
    });
    const vt = (k) => (card.querySelector('[data-k="' + k + '"]') || {}).value.trim();
    const resultEl = card.querySelector(".p-test-result");
    card.querySelector(".p-test").addEventListener("click", () => {
      if (!vt("api_key")) { resultEl.className = "p-test-result bad"; resultEl.textContent = "✗ 请先填 API Key"; return; }
      resultEl.className = "p-test-result";
      resultEl.textContent = "⏳ 测试中……";
      call({ action: "test_api", provider: { base_url: vt("base_url"), api_key: vt("api_key"), model: currentModelOf(card) } })
        .then((s2) => {
          const a = (s2 && s2.assist) || {};
          resultEl.className = "p-test-result " + (a.ok ? "ok" : "bad");
          resultEl.textContent = a.ok ? "✓ 可用（" + ((a.ms || 0) / 1000).toFixed(1) + " 秒）" : "✗ " + (a.error || "失败");
        })
        .catch((er) => { resultEl.className = "p-test-result bad"; resultEl.textContent = "✗ " + er.message; });
    });
    card.querySelector(".p-getmodels").addEventListener("click", () => {
      resultEl.className = "p-test-result";
      resultEl.textContent = "⏳ 获取中……";
      call({ action: "list_models", provider: { base_url: vt("base_url"), api_key: vt("api_key") } })
        .then((s2) => {
          const a = (s2 && s2.assist) || {};
          if (a.ok && a.models && a.models.length) {
            const prev = currentModelOf(card);
            msel.innerHTML = "";
            a.models.forEach((m2) => {
              const o = document.createElement("option");
              o.value = m2.id;
              o.textContent = (m2.name && m2.name !== m2.id) ? m2.name : m2.id;
              msel.appendChild(o);
            });
            if (prev) msel.value = prev;
            const oo = document.createElement("option");
            oo.value = "__custom__";
            oo.textContent = "✍ 自定义";
            msel.appendChild(oo);
            resultEl.className = "p-test-result ok";
            resultEl.textContent = "✓ 已获取 " + a.models.length + " 个模型";
          } else {
            resultEl.className = "p-test-result bad";
            resultEl.textContent = "✗ " + (a.error || "未获取到");
          }
        })
        .catch((er) => { resultEl.className = "p-test-result bad"; resultEl.textContent = "✗ " + er.message; });
    });
  });
}

function collectProviders() {
  const provs = {};
  document.querySelectorAll("#s-cards .p-card").forEach((card) => {
    const pid = card.dataset.pid || "p" + Object.keys(provs).length;
    const p = {};
    card.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (k === "model_custom") return;
      p[k] = el.value.trim();
    });
    // 兜底：确保厂商名称存在（服务器按名称过滤）
    if (!p.name) p.name = (card.querySelector(".p-name") || {}).textContent || pid;
    if (p.model === "__custom__") {
      const cu = card.querySelector('[data-k="model_custom"]');
      p.model = cu ? cu.value.trim() : "";
    }
    p.enabled = true;
    provs[pid] = p;
  });
  return provs;
}

$("#s-save").addEventListener("click", () => {
  call({ action: "providers_save", providers: collectProviders(), active_text: $("#s-active").value })
    .then((s) => {
      $("#s-msg").textContent = s.error ? "⚠ " + s.error : "✔ 已保存，立即生效";
      if (!s.error) renderSettings(s);
    })
    .catch((er) => { $("#s-msg").textContent = "⚠ " + er.message; });
});

$("#s-add").addEventListener("click", () => {
  const card = document.createElement("div");
  card.className = "p-card";
  card.dataset.pid = "custom_" + Date.now();
  card.innerHTML =
    '<div class="p-field">接口名称</div>' +
    '<input data-k="name" placeholder="接口名称">' +
    '<div class="p-field">接口地址</div>' +
    '<input data-k="base_url" placeholder="https://…">' +
    '<div class="p-field">API Key</div>' +
    '<input type="password" data-k="api_key" placeholder="sk-…">' +
    '<div class="p-field">对话模型</div>' +
    '<select data-k="model">' + modelOptions("default", "") + "</select>" +
    '<input data-k="model_custom" class="hidden" placeholder="自定义模型 ID">' +
    '<div class="p-btns">' +
    '<button class="p-test" type="button">🔍 测试连接</button>' +
    '<button class="p-getmodels" type="button">📋 获取模型</button>' +
    "</div>" +
    '<div class="p-test-result"></div>';
  $("#s-cards").appendChild(card);
  const msel = card.querySelector('[data-k="model"]');
  const cu = card.querySelector('[data-k="model_custom"]');
  msel.addEventListener("change", () => cu.classList.toggle("hidden", msel.value !== "__custom__"));
});

$("#s-export").addEventListener("click", () => {
  call({ action: "dump_all" }).then((s) => {
    const a = (s && s.assist) || {};
    const worlds = a.worlds || {};
    const mems = a.memories || {};
    const lines = ["万象幻境 · 全部记录导出", "导出时间：" + new Date().toLocaleString(), ""];
    Object.keys(worlds).forEach((wid) => {
      const w = worlds[wid];
      lines.push("═".repeat(40));
      lines.push("【" + (w.name || wid) + "】");
      lines.push("简介：" + (w.desc || ""));
      lines.push("═".repeat(40));
      const hist = (mems[wid] && mems[wid].history) || [];
      hist.forEach((m) => {
        lines.push((m.role === "assistant" ? "万象：" : "我：") + (m.content || ""));
        lines.push("");
      });
      lines.push("");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const aEl = document.createElement("a");
    aEl.href = URL.createObjectURL(blob);
    aEl.download = "万象幻境记录_" + new Date().toISOString().slice(0, 10) + ".txt";
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    toast("📄 记录已导出下载");
  }).catch((er) => toast("⚠ " + er.message));
});

/* ================= 访问码 ================= */

function showPin() {
  showScreen("pin");
}

$("#pin-ok").addEventListener("click", () => {
  const c = $("#pin-in").value.trim();
  if (!c) return;
  fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WX-Code": c, "X-WX-Device": deviceId() },
    body: JSON.stringify({ action: "state" }),
  })
    .then((r) => r.json())
    .then((s) => {
      if (s && s.error === "need_code") {
        $("#pin-msg").textContent = "❌ 访问码不对，请重新输入";
      } else {
        wxCode = c;
        localStorage.setItem("wx_code", c);
        $("#pin-msg").textContent = "";
        applyState(s);
      }
    })
    .catch(() => { $("#pin-msg").textContent = "⚠ 连接失败，请检查网络"; });
});
$("#pin-in").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pin-ok").click(); });

/* ================= 导航与输入 ================= */

$("#btn-add").addEventListener("click", () => {
  ["w-name", "w-desc", "w-world", "w-protagonist", "w-characters", "w-style", "w-rules"]
    .forEach((id) => { $("#" + id).value = ""; });
  $("#w-adv").open = false;
  showScreen("wizard");
});
$("#wiz-back").addEventListener("click", () => showScreen("worlds"));
$("#btn-back").addEventListener("click", () => {
  call({ action: "back_to_worlds" }).then(applyState).catch(() => {});
});
$("#btn-settings").addEventListener("click", () => {
  renderSettings(state);
  showScreen("settings");
});
$("#s-back").addEventListener("click", () => {
  if (state && state.mode === "game") showScreen("game");
  else showScreen("worlds");
});
$("#send").addEventListener("click", () => sendText($("#tin").value));
$("#tin").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText($("#tin").value);
  }
});
$("#tin").addEventListener("input", () => {
  const el = $("#tin");
  el.style.height = "auto";
  el.style.height = Math.min(140, el.scrollHeight) + "px";
});

/* ================= 启动 ================= */

function bootHide() {
  const el = document.getElementById("boot-loading");
  if (el) el.remove();
}
function bootFail(msg) {
  const el = document.getElementById("boot-msg");
  if (el) {
    el.textContent = msg;
    el.style.color = "#d07b6e";
  }
}

call({ action: "state" })
  .then((s) => { bootHide(); applyState(s); })
  .catch((er) => {
    bootFail("⚠ 连接服务器失败：" + er.message +
      "\n请确认网络正常后刷新本页（Mac 按 ⌘+Shift+R）。若长时间打不开，可能是服务器正在唤醒，等 60 秒再刷新。");
    showPin();
  });
