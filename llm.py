# -*- coding: utf-8 -*-
"""万象幻境 · LLM 客户端

支持多厂商：
- 文本对话：OpenAI 兼容格式（DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 自定义）
- 图像生成：智谱 cogview 格式 或 OpenAI 兼容格式（dall-e / gpt-image 等）
配置由 config.json 的 providers / active_text / active_image 决定。
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request


class LLMError(Exception):
    """AI 不可用时的友好异常。"""


def _endpoint(base_url):
    url = (base_url or "").strip().rstrip("/")
    if not url:
        raise LLMError("未配置 base_url")
    if url.endswith("/chat/completions"):
        return url
    if re.match(r".*/v\d+$", url):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def _post_json(url, payload, api_key, timeout):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(api_key).strip(),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        raise LLMError(f"API 返回错误 {e.code}：{detail or e.reason}")
    except urllib.error.URLError as e:
        raise LLMError(f"网络错误：{e.reason}")
    except TimeoutError:
        raise LLMError("请求超时，请稍后重试")


def _download(url, timeout):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise LLMError(f"图片下载失败：HTTP {e.code}")
    except Exception as e:
        raise LLMError(f"图片下载失败：{e}")


def _timeout_of(cfg):
    legacy = cfg.get("api") or {}
    return legacy.get("timeout", 300)


# =========================================================
# 文本对话
# =========================================================

def _text_cfg(cfg):
    """当前生效的文本模型厂商配置。"""
    provs = cfg.get("providers") or {}
    active = cfg.get("active_text", "")
    p = provs.get(active)
    if p and str(p.get("api_key", "")).strip():
        return p
    for k, v in provs.items():
        if v.get("enabled", True) and str(v.get("api_key", "")).strip():
            return v
    return cfg.get("api") or {}


def api_ready(cfg):
    p = _text_cfg(cfg)
    return bool(p.get("enabled", True)) and bool(str(p.get("api_key", "")).strip())


def _models_endpoint(base_url):
    url = (base_url or "").strip().rstrip("/")
    if not url:
        raise LLMError("未配置 base_url")
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    if re.match(r".*/v\d+$", url):
        return url + "/models"
    return url + "/v1/models"


def list_models(cfg=None, provider=None):
    """获取该密钥可用的模型列表，返回 [{"id":…, "name":…}]。"""
    if provider and str(provider.get("api_key", "")).strip():
        p = provider
    else:
        p = _text_cfg(cfg or {})
    if not str(p.get("api_key", "")).strip():
        raise LLMError("未配置 API 密钥")
    url = _models_endpoint(p.get("base_url", ""))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + str(p["api_key"]).strip()})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        raise LLMError(f"获取模型列表失败 {e.code}：{detail or e.reason}")
    except urllib.error.URLError as e:
        raise LLMError(f"网络错误：{e.reason}")
    except TimeoutError:
        raise LLMError("获取模型列表超时")
    items = data.get("data") if isinstance(data, dict) else None
    out = []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and it.get("id"):
                out.append({"id": str(it["id"]), "name": str(it.get("name") or it["id"])})
    return out


def test_chat(cfg, provider=None):
    """用极短提示测试连接；provider 可临时覆盖（用于测试未保存的配置）。"""
    if provider is not None and isinstance(provider, dict):
        cfg2 = json.loads(json.dumps(cfg or {}))
        provs = cfg2.setdefault("providers", {})
        provs["__test__"] = {
            "name": "测试", "type": "text", "enabled": True,
            "base_url": str(provider.get("base_url", "") or ""),
            "api_key": str(provider.get("api_key", "") or ""),
            "model": str(provider.get("model", "") or ""),
            "img_model": "", "img_api": "openai",
        }
        cfg2["active_text"] = "__test__"
        cfg = cfg2
    t0 = time.time()
    res = chat([{"role": "user", "content": "请只回复两个字：正常"}], cfg)
    return {"ms": int((time.time() - t0) * 1000), "reply": res["content"][:60]}


THINK_PATTERNS = [
    r"<think(?:ing)?\s*>(.*?)(?:</think(?:ing)?\s*>|<｜end▁of▁thinking｜>)",
    r"【思考过程】(.*?)【/思考过程】",
    r"【思考】(.*?)【/思考】",
    r"\[思考\](.*?)\[/思考\]",
    r"\[thinking\](.*?)\[/thinking\]",
    r"（思考）(.*?)（/思考）",
    # 英文思考常见的整段形式：Thinking Process / Let me think … 等
    r"(?im)^\s*(?:thinking process|reasoning|thought process)\s*[:：]\s*(.+?)(?=\n\s*\n\s*\S|\Z)",
]


def split_thinking(text):
    """把混在正文里的思考内容分离出来，返回 (正文, 思考)。"""
    text = text or ""
    found = []

    def _grab(m):
        inner = (m.group(1) or "").strip()
        if inner:
            found.append(inner)
        return ""

    for pat in THINK_PATTERNS:
        text = re.sub(pat, _grab, text, flags=re.S | re.I)
    # 未闭合的  thinking：其后全部算思考
    m = re.search(r"<think(?:ing)?\s*>", text, re.I)
    if m:
        tail = text[m.end():].strip()
        if tail:
            found.append(tail)
        text = text[:m.start()]
    # 开头「思考：/分析：/推理：」+ 空行 形式的思考段
    m = re.match(r"\s*(?:思考|分析|推理|thinking|reasoning)\s*[:：]\s*(.+?)\n\s*\n", text, re.S | re.I)
    if m:
        found.append(m.group(1).strip())
        text = text[m.end():]
    # 英文思考腔的开头（Okay, the user… / Let me… / First, I need to…）在首段出现时剥离
    m = re.match(r"\s*((?:okay|ok|alright|sure|hmm)[,.!]?\s+(?:the user|let me|i need|i should|so the user)"
                 r"[\s\S]{20,}?)(?=\n\s*\n)", text, re.I)
    if m:
        found.append(m.group(1).strip())
        text = text[m.end():]
    m = re.match(r"\s*((?:let me|i need to|first,? i|thinking)[\s\S]{20,}?)(?=\n\s*\n)", text, re.I)
    if m:
        found.append(m.group(1).strip())
        text = text[m.end():]
    text = re.sub(r"^\s*(?:思考过程|思考|thinking|reasoning)\s*[:：]\s*$", "", text, flags=re.I | re.M)
    return text.strip(), "\n\n".join(found).strip()


def chat(messages, cfg, max_tokens=None):
    """调用文本模型，返回 {"content": 最终回复, "reasoning": 思考过程}。

    注意：思考内容永远不会被当作正文返回（只在「查看思考过程」里显示）。
    """
    p = _text_cfg(cfg)
    if not str(p.get("api_key", "")).strip():
        raise LLMError("未配置对话 API 密钥：请到「⚙ 设置 → API 接口管理」填写")
    legacy = cfg.get("api") or {}
    url = _endpoint(p.get("base_url", ""))
    limit = max_tokens or p.get("max_tokens") or legacy.get("max_tokens", 8000)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 8000
    def _once(msgs, tok):
        payload = {
            "model": p.get("model") or "deepseek-v4-pro",
            "messages": msgs,
            "temperature": legacy.get("temperature", 1.0),
            "max_tokens": tok,
        }
        data = _post_json(url, payload, p.get("api_key", ""), _timeout_of(cfg))
        try:
            return data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"API 响应解析失败：{e}")

    msg = _once(messages, limit)
    raw = (msg.get("content") or "").strip()
    reasoning = ""
    for k in ("reasoning_content", "reasoning", "thinking"):
        v = msg.get(k)
        if isinstance(v, str) and v.strip():
            reasoning = v.strip()
            break
    content, inline = split_thinking(raw)
    if inline:
        reasoning = (reasoning + "\n\n" + inline).strip() if reasoning else inline
    if not content and reasoning:
        # 模型把额度全用于思考：追问一次，明确只要正文（绝不把思考当正文）
        retry_msgs = list(messages) + [{
            "role": "user",
            "content": "（请直接输出你要写的内容本身，不要输出任何思考过程、分析或推理步骤。）",
        }]
        try:
            msg2 = _once(retry_msgs, max(limit, min(32000, limit * 2)))
            raw2 = (msg2.get("content") or "").strip()
            content2, inline2 = split_thinking(raw2)
            if inline2:
                reasoning = (reasoning + "\n\n" + inline2).strip()
            content = content2
        except LLMError:
            content = ""
    if not content:
        raise LLMError("模型这次只输出了思考内容，没有给出正文。请再试一次，或换个模型。")
    return {"content": content, "reasoning": reasoning}


# =========================================================
# 图像生成
# =========================================================

def image_ready(cfg):
    provs = cfg.get("providers") or {}
    p = provs.get(cfg.get("active_image", "")) or {}
    return bool(str(p.get("api_key", "")).strip())


def image_generate(prompt, cfg, save_dir):
    """生成图片并保存到 save_dir，返回文件名。"""
    provs = cfg.get("providers") or {}
    p = provs.get(cfg.get("active_image", "")) or {}
    if not str(p.get("api_key", "")).strip():
        raise LLMError("未配置图像生成密钥：请到「⚙ 设置 → API 接口管理」为图像模型填写 API Key")
    base = (p.get("base_url") or "").strip().rstrip("/")
    timeout = _timeout_of(cfg)
    api_key = str(p.get("api_key", "")).strip()

    if p.get("img_api") == "zhipu":
        url = base + "/images/generations"
        payload = {"model": p.get("img_model") or "cogview-3-flash",
                   "prompt": prompt, "size": "1024x1024"}
        data = _post_json(url, payload, api_key, timeout)
        try:
            img_url = data["data"][0]["url"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"智谱图像接口响应异常：{e}")
        img_bytes = _download(img_url, timeout)
    else:
        url = base + "/images/generations"
        payload = {"model": p.get("img_model") or "dall-e-3",
                   "prompt": prompt, "n": 1, "size": "1024x1024"}
        data = _post_json(url, payload, api_key, timeout)
        try:
            item = data["data"][0]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"图像接口响应异常：{e}")
        if item.get("b64_json"):
            img_bytes = base64.b64decode(item["b64_json"])
        elif item.get("url"):
            img_bytes = _download(item["url"], timeout)
        else:
            raise LLMError("图像接口返回格式异常（既无 url 也无 b64_json）")

    if not img_bytes:
        raise LLMError("图像接口返回了空图片")
    os.makedirs(save_dir, exist_ok=True)
    fname = "img_" + time.strftime("%Y%m%d_%H%M%S") + ".png"
    with open(os.path.join(save_dir, fname), "wb") as f:
        f.write(img_bytes)
    return fname
