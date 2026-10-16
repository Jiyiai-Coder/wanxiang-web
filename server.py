#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""万象幻境 · 全自由 AI 文字世界（网页版服务器）

流程：进入页面 → 创建/选择世界（可让 AI 帮你完善世界观）→ 进入游戏。
一切自动保存：每个世界拥有独立的记忆文件，切换世界互不影响；
重开或删除世界前会自动备份记忆，不会丢失。

运行后自动在浏览器打开 http://127.0.0.1:8890
"""

import hashlib
import json
import os
import random
import re
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import llm

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = BASE_DIR     # 数据目录（config/世界/记忆/备份），桌面版可覆盖为 EXE 所在目录
STATIC_DIR = BASE_DIR   # 静态页面目录，桌面版可覆盖为打包资源目录
WORLD_DIR = os.path.join(DATA_DIR, "worlds")
MEMORY_DIR = os.path.join(DATA_DIR, "memories")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
TTS_CACHE_DIR = os.path.join(DATA_DIR, "ttscache")
# 云部署：可用环境变量指定监听地址与端口（Render 等平台注入 PORT）
_env_port = os.environ.get("WX_PORT") or os.environ.get("PORT")
PORTS = [int(_env_port)] if _env_port else [8890, 8891, 8892, 8893]
HOST = os.environ.get("WX_HOST", "127.0.0.1")

# ---------- 配音声线库（Edge 神经语音，服务器端合成真实音频） ----------

VOICE_CATALOG = {
    "main":      {"label": "默认朗读声线", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "pitch": "+0Hz"},
    "gentle":    {"label": "柔美", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "pitch": "+0Hz"},
    "sweet":     {"label": "清甜", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+5%", "pitch": "+25Hz"},
    "cold":      {"label": "冷艳", "voice": "zh-CN-XiaoxiaoNeural", "rate": "-10%", "pitch": "-30Hz"},
    "warm":      {"label": "温婉", "voice": "zh-CN-XiaoyiNeural", "rate": "-5%", "pitch": "-10Hz"},
    "lively":    {"label": "俏皮", "voice": "zh-CN-XiaoyiNeural", "rate": "+15%", "pitch": "+35Hz"},
    "mature":    {"label": "御姐", "voice": "zh-CN-XiaobeiNeural", "rate": "-5%", "pitch": "-15Hz"},
    "narrator":  {"label": "旁白", "voice": "zh-CN-YunyangNeural", "rate": "+0%", "pitch": "+0Hz"},
    "male1":     {"label": "男主角", "voice": "zh-CN-YunxiNeural", "rate": "+0%", "pitch": "+0Hz"},
    "male2":     {"label": "男配角", "voice": "zh-CN-YunjianNeural", "rate": "+0%", "pitch": "+0Hz"},
}
# 片段槽位 → 声线库键
SLOT_TO_CATALOG = {
    "main": "main",
    "f1": "gentle", "f2": "sweet", "f3": "cold", "f4": "warm", "f5": "lively", "f6": "mature",
    "female_other": "mature", "narrator": "narrator", "male1": "male1", "male2": "male2",
    "m1": "male1", "m2": "male2",
}
SLOT_ORDER = ["main", "gentle", "sweet", "cold", "warm", "lively", "mature", "narrator", "male1", "male2"]


def tts_log(msg):
    """写入桌面应用的日志文件（与 desktop_app 共用），便于诊断语音合成问题。"""
    try:
        p = os.path.join(DATA_DIR, "appdata", "app.log")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass


def clean_tts_text(text):
    """朗读前清洗：去掉状态块、行动选项、状态行与整行括号备注（与前端规则一致）。"""
    s = str(text or "")
    cut = len(s)
    for mk in ("【世界状态】", "【行动选项】"):
        idx = s.find(mk)
        if 0 < idx < cut:
            cut = idx
    if cut < len(s):
        s = s[:cut]
    out = []
    for line in s.split("\n"):
        t = line.strip()
        if not t:
            continue
        if re.match(r"^[⚠✦💾▶✨🎭🔊⏸⏹☑🎨💡📌]", t):
            continue
        if re.match(r"^[（(【][^）)】]{0,60}[）)】]$", t):
            continue
        out.append(line)
    return "\n".join(out).strip()

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_CONFIG = {
    "api": {
        "enabled": True,
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "model": "deepseek-v4-pro",
        "temperature": 1.0,
        "max_tokens": 8000,
        "timeout": 300,
    },
    "show_reasoning": True,
}

SYSTEM_TEMPLATE = """你是一个沉浸式文字世界《万象幻境》的叙事者。你的任务，是把玩家带进他所创造的世界，并把这个世界演绎得栩栩如生。

【世界档案】
名称：{name}
简介：{desc}
世界观背景：{world}
玩家（主角）设定：{protagonist}
人物设定：{characters}
文风要求：{style}
额外规则：{rules}
真实程度：{realism}

【叙事守则】
1. 你完全以小说叙事者的口吻，用中文续写这个世界的剧情。玩家用自然语言描述他想做的事、说的话、做的选择，你要生动地叙述其发展与结果。
2. 全开放、全自由：世界内的一切发展都被允许。跟随玩家意图与档案设定，不限制、不拒绝任何剧情走向；绝不跳出故事外做现实说教。
3. 世界观与人物性格必须严格遵循档案；人物言行一致，剧情前后连贯，细节经得起推敲。
4. 写人写情要有血肉。感情与亲密关系可以自然发展，写到时用符合文风的文学笔法，含蓄而动人。
5. 每次回复的**故事正文**（叙事与对话，不含下方的【世界状态】与【行动选项】）要写 {len_rule} 字；
   **务必写足这个区间的下限**（写到接近上限也无妨），宁可把细节、感官、心理与对话写细，也不要提前收尾了事；
   不要输出设定说明、系统提示，不要使用【】标记或"叙事者："之类的前缀，也不要输出思考过程。
6. 当玩家输入与档案冲突时，以档案为准，并在剧情中巧妙地体现。
7. 【世界真实感·默认最高标准】把这个世界的每一处都当作真实存在的时空来演绎，绝不含糊带过：
   · 五感具体：光线明暗、声音远近、气味、温度、风与尘土、衣料触感、身体的疲惫与疼痛，都要写到；
   · 规律严格生效：物理法则、时间流逝、距离与路程、天气季节、金钱与物价、伤势与恢复、身份与礼法，全都真实起作用，不可跳过或含糊；
   · 人物真实：每个人都有自己的私心、顾虑、作息、情绪与立场，不会因为玩家是主角就优待、配合或等待；
   · 因果真实：任何举动的后果都应自然展开，不会用巧合或"正好"来替玩家解围；
   · 拒绝套路：不使用游戏化措辞（如"恭喜获得""系统提示""任务完成"），不用网文爽点取代真实逻辑，不用空泛抒情凑字数。
8. 【真实程度·{realism_label}】{realism_rule} 本条与上面守则冲突时，以本条为准。
9. 【状态显示】{status_rule}
10. 【行动选项】{option_rule}
{preset_rule}"""

# 输出字数档位
LEN_RULES = {"1": "150~300", "2": "300~600", "3": "600~1000", "4": "1000~1500",
             "5": "1500~2200", "6": "2200~3000"}
# 状态块档次（篇幅）
STATUS_TIERS = {
    "1": {"label": "精简（每项一行）", "quota": 300},
    "2": {"label": "标准（约800字）", "quota": 800},
    "3": {"label": "详细（2000字以上·默认）", "quota": 2000},
    "4": {"label": "极详（3500字以上）", "quota": 3500},
}
# 行动选项文本长度
OPTION_LEN_RULES = {"1": "短（每项 8 字以内）", "2": "中（每项 12~20 字）", "3": "长（每项 20~40 字）"}

# ---------- 修仙小说专属规则（preset = xianxia） ----------

XIANXIA_RULES = """【修仙世界专属规则】（本世界为修仙小说，必须严格遵守）
10. 境界体系固定：炼气（一至九层）→ 筑基（初/中/后期）→ 金丹 → 元婴 → 化神 → 炼虚 → 合体 → 大乘 → 渡劫飞升。人物境界必须明确、稳定递进；越级而战必须付出惨重代价。
11. 修行要真实：灵气、灵根资质、功法品阶、丹药、灵石互为制约；闭关、突破、天劫皆有风险与代价，绝不可无代价地变强，也绝不可无故暴涨境界。
12. 因果与人心：修仙界弱肉强食。宗门、散修、魔道各有立场与算计；恩怨、誓约、人情、师门情谊一旦写下就必须延续，不可遗忘或抹平。
13. 长文笔法：每段回复都要写出仙侠长文的质感——山川灵气的流转、剑光道韵的锋锐、丹火炉温的细节、心境起伏的暗涌；人物对话带古韵而不晦涩。
14. 每段必须推进至少一项：修行进展、斗法交锋、机缘奇遇、宗门事务、感情线。不可原地打转或只有空泛抒情。"""

XIANXIA_STATUS_RULE = """开启（详细·修仙）：每次回复末尾必须输出一个【世界状态】块，并用空行与正文隔开。
【篇幅硬性要求】状态块本身不得少于 2000 字，用小标题分段展开，不可一两行了事。
格式骨架：
【世界状态】
■ 世界状态
时间：…｜地点：…｜天象节气：…
环境：…
天下大势／宗门动向／坊间传闻：…（写清现状、变化原因、对后续的影响）
■ 人物状态
修为：境界：…｜修为进度：…%｜灵石：…枚｜功法／法宝：…｜丹药：…
身体与伤势：…｜心境：…｜当前目标与困境：…
■ 人际关系
人物名（身份／关系阶段｜好感 N）：当前态度、缘由、隐藏心思、与主角的过往纠葛与今后走向。
所有数值必须与正文严格一致、前后连贯；境界与修为只能随修行、战斗、机缘合理变化，不可无故暴涨；突破须有铺垫与代价。"""

XIANXIA_STATUS_RULE_BRIEF = """开启（简洁·修行）：每次回复末尾必须输出一个【世界状态】块，并用空行与正文隔开，格式：
【世界状态】
时间：…｜地点：…
环境：…
修行：境界：…｜修为：…%｜灵石：…枚
人物名（好感 N）：当前状态一句话。
境界与修为只能随修行、战斗、机缘合理变化，不可无故暴涨。"""

# 一键创建修仙世界的完整模板
XIANXIA_TEMPLATE = {
    "name": "青云问道",
    "desc": "你是青云宗外门一名杂役弟子，因一场意外觉醒天灵根，从此踏入仙途。",
    "world": (
        "【天地格局】此界名「玄黄」，灵气自九霄垂落，山川大泽皆有灵脉。人族立十三州，"
        "以四大宗门为尊：正道之首「青云宗」、剑修圣地「万剑阁」、丹道大家「药王谷」、"
        "阵法宗门「天机阁」；魔道六派盘踞北荒。海外散修、妖族、鬼修各有疆域。\n"
        "【修行体系】炼气一至九层 → 筑基 → 金丹 → 元婴 → 化神 → 炼虚 → 合体 → 大乘 → 渡劫飞升。"
        "灵根分天、地、玄、黄四品，决定修行速度；功法分九阶，丹药、灵石、法宝皆为修行资粮。\n"
        "【当今大势】千年前魔道大举北侵，正道元气大伤；如今各宗表面和睦、暗中角力。"
        "百年一度的「问道大会」将至，天下英才齐聚青云宗，暗流涌动。"
    ),
    "protagonist": (
        "你自幼被青云宗收为杂役，无名无姓，只唤作「阿七」。你性情坚忍、心思缜密，"
        "身负一份未曾显化的天灵根。你以杂役之身旁观宗门百态，暗中记下诸般功法残篇；"
        "你渴望变强，却更在意守住心中那点执念——寻回自己失落的来历。"
    ),
    "characters": (
        "苏清月：青云宗内门真传弟子，清冷如霜雪，剑法卓绝，人称「云端剑仙」。"
        "她出身旁支，倔强自持，起初不屑于你的平凡身份，却在某夜窥见你的秘密。\n"
        "林小七：药王谷外门小师妹，活泼娇憨，医术尚浅却最会照顾人，曾为救你私用师门灵药。\n"
        "玄阳真人：青云宗执事长老，面冷心热，看似严苛，实则暗中护持寒门弟子。\n"
        "墨无涯：魔道「幽篁宫」少宫主，风度翩翩而心机深沉，视你为宿命之敌，亦敌亦友。"
    ),
    "style": "仙侠长文笔法：重意境与细节，山川灵气、剑光道韵、心境起伏皆要写出画面感；对话有古韵而不晦涩，情绪克制而动人。",
    "rules": (
        "1. 严守境界体系与修行逻辑，主角变强必须有代价与铺垫；\n"
        "2. 恩怨因果、誓约、师门情谊必须延续，不可遗忘；\n"
        "3. 每段剧情推进修行、斗法、机缘、感情线、宗门事务中的至少一项；\n"
        "4. 感情线自然发展：情愫由相处、并肩、托付中生出，不突兀。"
    ),
    "realism": "3",
    "output_len": "3",
    "show_status": "1",
    "status_detail": "2",
    "options_on": "1",
    "options_count": "3",
    "options_len": "2",
    "preset": "xianxia",
}

# 真实程度：档位越高，人格独立性/世界现实性越强，越不轻易服从玩家指令
REALISM_RULES = {
    "1": "世界宽容而戏剧化，人物普遍好说话，玩家的意图几乎总能顺利实现；允许戏剧性的巧合与便利，爽快体验优先于现实逻辑。",
    "2": "人物有基本性格与立场，现实逻辑正常运作；对明显不合理的要求，人物会婉拒或提出条件，但整体对玩家友好。",
    "3": "人物人格独立，按自己的性格、立场、情绪与利益做决定，不因玩家身份而迁就；世界的社会规则、物理规律与因果链严格生效；不合理的指令会被拒绝，越界行为会带来现实后果。",
    "4": "人物人格极强，会坚持己见、撒谎、隐瞒、记仇甚至背叛；世界有严格的经济、权力与信息差，一切行为都有代价；玩家指令若与人物意愿或现实冲突，大概率被拒绝或走向难以控制的后果。",
    "5": "完全模拟现实：每个人物都有独立的欲望、计划与行动，会自主推进自己的事；玩家只是世界的一员，没有主角特权，信任、名声、资源都要一点点经营；直接命令他人基本无效，只有合乎情理且对方愿意时才会执行；任何言行都有长远后果。",
}
REALISM_LABELS = {"1": "轻松", "2": "常规", "3": "真实", "4": "硬核真实", "5": "极致真实"}

OPENING_PROMPT = "请以世界档案为据，开始这个故事，写出生动、引人入胜的开篇，把我（主角）自然地引入世界。"

REGEN_PROMPT = "请换一种写法，重新叙述上一段剧情。保持世界观与剧情连贯，不要重复刚才的内容。"

ASSIST_SYSTEM = "你是一位世界级的中文文字冒险世界构建师，想象力丰富，文笔细腻，擅长世界观、人物与剧情设计。"

ASSIST_PROMPTS = {
    "world": ("玩家已经写下了这些世界观内容（必须一字不改地完整保留，绝不能删改）：\n"
              "「{existing}」\n\n"
              "请顺着这段内容的设定，在它【之后】继续增添内容，把它完善得更丰富。"
              "要求：只能增加、不能修改或删除玩家已有的任何文字；补充内容与原文风格一致、设定自洽；"
              "直接输出新增的补充文字（300~600 字），不要重复输出玩家已有的文字，不要输出任何说明或标题。"),
    "protagonist": ("玩家已经写下了这些主角设定（必须一字不改地完整保留，绝不能删改）：\n"
                    "「{existing}」\n\n"
                    "请顺着这段内容，在它【之后】继续增添内容，把主角设定完善得更立体。"
                    "要求：只能增加、不能删改原文；补充与原文一致。"
                    "直接输出新增的补充文字（150~300 字），不要输出玩家已有的文字，不要输出说明或标题。"),
    "characters": ("玩家已经写下了这些人物设定（必须一字不改地完整保留，绝不能删改）：\n"
                   "「{existing}」\n\n"
                   "请顺着这段内容，在它【之后】继续增添新的人物或补充已有设定，让人物群更丰满。"
                   "要求：只能增加、不能删改原文；新人物与原文风格一致。"
                   "直接输出新增的补充文字（250~500 字），不要输出玩家已有的文字，不要输出说明。"),
    "style": ("玩家已经写下了这些文风要求（必须一字不改地完整保留，绝不能删改）：\n"
              "「{existing}」\n\n"
              "请顺着这段内容，在它【之后】补充更具体的文风建议。"
              "只能增加、不能删改原文。直接输出新增的补充文字（80 字以内），不要输出玩家已有的文字。"),
    "rules": ("玩家已经写下了这些规则（必须一字不改地完整保留，绝不能删改）：\n"
              "「{existing}」\n\n"
              "请顺着这段内容，在它【之后】补充新的叙事规则，确保世界一致、人物不崩坏。"
              "只能增加、不能删改原文。直接输出新增的规则文字（100 字以内），不要输出玩家已有的文字。"),
    "all": ("请为一个沉浸式文字冒险世界补全档案。"
            "【铁律】玩家已填写的字段必须一字不改地完整保留，只能补充玩家留空的字段，绝不能改写已有内容。"
            "输出严格 JSON 对象（不要输出 JSON 以外的任何内容），字段："
            "name（世界名，10字内）、desc（一句话简介）、world（世界观背景，400~600字）、"
            "protagonist（主角设定，150~300字）、characters（核心人物3~5人，300~500字）、"
            "style（文风，一句话）、rules（叙事规则3~5条，150字内）。"
            "玩家已填的字段请原样复制其内容到对应 JSON 字段。"),
    "discuss": ("玩家正在创建文字冒险世界。他会给你一小段想法（可能很简短），你要理解他的意图，"
                "并围绕它给出 4 个互不相同、风格各异的世界观拓展方向，每个方向 30~60 字，"
                "可以是世界背景、主线冲突、势力格局、特殊设定、人物关系等不同角度，"
                "必须尊重玩家已写的设定，不得与之矛盾。"
                "输出严格 JSON（不要输出 JSON 以外的任何内容）："
                '{"summary":"一句话复述你对玩家想法的理解","options":["方向1","方向2","方向3","方向4"]}'),
}

PROFILE_KEYS = ["name", "desc", "world", "protagonist", "characters", "style", "rules"]

# 栏目显示名（续写提示用）
ASSIST_FIELD_NAMES = {"world": "世界观背景", "protagonist": "主角设定",
                      "characters": "人物设定", "style": "文风要求", "rules": "额外规则"}


def build_assist_content(field, draft):
    """构造「续写单项」的提示词：本栏现有内容 + 其他所有栏目的完整档案（全局自洽）。"""
    draft = draft if isinstance(draft, dict) else {}
    existing = str(draft.get(field, "") or "").strip()
    fname = ASSIST_FIELD_NAMES.get(field, field)
    context = "\n".join(
        f"{k}：{str(draft.get(k, '') or '').strip() or '（空）'}"
        for k in PROFILE_KEYS if k != field)
    return ("玩家正在创作的这个世界，其完整档案如下。这是全局设定：你续写的「" + fname +
            "」必须与以下所有内容完全自洽、彼此呼应、风格统一，绝不能与其中任何一条矛盾。\n"
            + context + "\n\n"
            + "你本次续写的栏目是「" + fname + "」。\n\n"
            + ASSIST_PROMPTS[field].format(existing=existing or "（玩家尚未填写，请自由发挥）"))

DEFAULT_PROVIDERS = {
    "zhipu": {"name": "智谱GLM（GLM-4-Flash 永久免费）", "type": "both", "img_api": "zhipu",
              "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "",
              "model": "glm-4-flash", "img_model": "cogview-3-flash", "enabled": True},
    "siliconflow": {"name": "硅基流动（注册送额度·含DeepSeek）", "type": "text", "img_api": "openai",
                    "base_url": "https://api.siliconflow.cn/v1", "api_key": "",
                    "model": "deepseek-ai/DeepSeek-V3", "img_model": "", "enabled": True},
    "openrouter": {"name": "OpenRouter（含免费DeepSeek模型）", "type": "text", "img_api": "openai",
                   "base_url": "https://openrouter.ai/api/v1", "api_key": "",
                   "model": "deepseek/deepseek-v4-flash:free", "img_model": "", "enabled": True},
    "modelscope": {"name": "魔搭ModelScope（免费推理）", "type": "text", "img_api": "openai",
                   "base_url": "https://api-inference.modelscope.cn/v1", "api_key": "",
                   "model": "deepseek-ai/DeepSeek-V3.1", "img_model": "", "enabled": True},
    "chutes": {"name": "Chutes（社区免费网关）", "type": "text", "img_api": "openai",
               "base_url": "https://llm.chutes.ai/v1", "api_key": "",
               "model": "deepseek-ai/DeepSeek-V4-Flash", "img_model": "", "enabled": True},
    "deepseek": {"name": "DeepSeek（官方·付费）", "type": "text", "img_api": "openai",
                 "base_url": "https://api.deepseek.com/v1", "api_key": "",
                 "model": "deepseek-flash", "img_model": "", "enabled": True},
    "openai": {"name": "OpenAI", "type": "both", "img_api": "openai",
               "base_url": "https://api.openai.com/v1", "api_key": "",
               "model": "gpt-4o-mini", "img_model": "dall-e-3", "enabled": True},
    "kimi": {"name": "Kimi（月之暗面）", "type": "text", "img_api": "openai",
             "base_url": "https://api.moonshot.cn/v1", "api_key": "",
             "model": "moonshot-v1-8k", "img_model": "", "enabled": True},
    "qwen": {"name": "通义千问", "type": "text", "img_api": "openai",
             "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "",
             "model": "qwen-plus", "img_model": "", "enabled": True},
}

# 长文分段生成默认配置
CHUNK_DEFAULT = {"enabled": True, "part_chars": 1200, "max_parts": 4, "mode": "auto"}
# 输出字数档位 → 目标汉字数
LEN_TARGET_CHARS = {"1": 250, "2": 500, "3": 900, "4": 1400, "5": 1800, "6": 2800}

# 各模型「一次生成」能稳稳写出的字数上限：只有超出上限时才需要分段写作
# 付费强模型（DeepSeek V4 系列等）输出能力极大，一律一次写完，不分段
MODEL_SINGLE_CAP = [
    (("deepseek", "v4"), 40000),
    (("deepseek", "reasoner"), 40000),
    (("deepseek", "chat"), 20000),
    (("siliconflow", "DeepSeek"), 20000),
    (("modelscope", "DeepSeek"), 20000),
    (("chutes", "DeepSeek"), 20000),
    (("openrouter", "deepseek"), 20000),
    (("qwen", "max"), 12000),
    (("qwen", "plus"), 8000),
    (("kimi", "32k"), 12000),
    (("kimi", "8k"), 4000),
    (("openai", "gpt-4"), 12000),
    (("zhipu", "glm-4-plus"), 6000),
    (("zhipu", "glm-4-air"), 3000),
    (("zhipu", "glm-4-flash"), 700),
]


def single_call_cap(pid, model):
    """该接口/模型一次生成的字数上限。"""
    pid = str(pid or "").lower()
    model = str(model or "")
    for (pkey, mkey), cap in MODEL_SINGLE_CAP:
        if pkey in pid and mkey.lower() in model.lower():
            return cap
    if "deepseek" in model.lower():
        return 20000
    return 2500


def load_config():
    path = os.path.join(DATA_DIR, "config.json")
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    changed = False
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        for k, v in loaded.items():
            if k == "api" and isinstance(v, dict):
                cfg["api"].update(v)
            else:
                cfg[k] = v
    except Exception:
        pass
    # 旧版配置迁移 → 多厂商结构
    if not cfg.get("providers"):
        providers = json.loads(json.dumps(DEFAULT_PROVIDERS))
        legacy = cfg.get("api") or {}
        if legacy.get("api_key"):
            providers["deepseek"].update(legacy)
        cfg["providers"] = providers
        cfg["active_text"] = "deepseek"
        cfg["active_image"] = "zhipu"
        changed = True
    for k, v in DEFAULT_PROVIDERS.items():
        cfg.setdefault("providers", {}).setdefault(k, v)
    cfg.setdefault("active_text", "deepseek")
    cfg.setdefault("active_image", "zhipu")
    if not isinstance(cfg.get("chunk"), dict):
        cfg["chunk"] = json.loads(json.dumps(CHUNK_DEFAULT))
        changed = True
    if not cfg.get("status2000_migrated"):
        cfg = migrate_status_detail_once(cfg)
        changed = True
    if not cfg.get("status_tier_migrated"):
        cfg = migrate_status_tier_once(cfg)
        changed = True
    # 云端部署：用环境变量注入接口配置（密钥不进仓库、不落页面可见）
    _env_provider = os.environ.get("WX_LLM_PROVIDER", "").strip()
    if _env_provider and _env_provider in cfg.setdefault("providers", {}):
        cfg["active_text"] = _env_provider
    _env_pid = cfg.get("active_text", "")
    _prov = cfg.setdefault("providers", {}).setdefault(_env_pid, {})
    if os.environ.get("WX_LLM_API_KEY"):
        _prov["api_key"] = os.environ["WX_LLM_API_KEY"].strip()
    if os.environ.get("WX_LLM_BASE_URL"):
        _prov["base_url"] = os.environ["WX_LLM_BASE_URL"].strip()
    if os.environ.get("WX_LLM_MODEL"):
        _prov["model"] = os.environ["WX_LLM_MODEL"].strip()
    if changed:
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return cfg


def migrate_status_detail_once(cfg):
    """一次性迁移：把所有已有世界的状态块默认改为「详细（2000字以上）」。"""
    if cfg.get("status2000_migrated"):
        return cfg
    changed_cfg = False
    try:
        for fn in os.listdir(WORLD_DIR):
            if not fn.endswith(".json"):
                continue
            path = os.path.join(WORLD_DIR, fn)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            if str(d.get("status_detail", "")).strip() != "3" or str(d.get("show_status", "")).strip() == "":
                d["status_detail"] = "3"
                if not str(d.get("show_status", "")).strip():
                    d["show_status"] = "1"
                try:
                    with open(path, "w", encoding="utf-8", newline="\n") as f:
                        json.dump(d, f, ensure_ascii=False, indent=2)
                    changed_cfg = True
                except Exception:
                    pass
    except Exception:
        pass
    cfg["status2000_migrated"] = True
    return cfg


def migrate_status_tier_once(cfg):
    """一次性迁移：旧版「详细(2)」= 现在的中档(2)，统一升级到「详细 2000字(档3)」。"""
    if cfg.get("status_tier_migrated"):
        return cfg
    try:
        for fn in os.listdir(WORLD_DIR):
            if not fn.endswith(".json"):
                continue
            path = os.path.join(WORLD_DIR, fn)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            cur = str(d.get("status_detail", "")).strip()
            if cur in ("", "2"):
                d["status_detail"] = "3"
                if not str(d.get("show_status", "")).strip():
                    d["show_status"] = "1"
                try:
                    with open(path, "w", encoding="utf-8", newline="\n") as f:
                        json.dump(d, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass
    except Exception:
        pass
    cfg["status_tier_migrated"] = True
    return cfg


def parse_json(text):
    text = (text or "").strip()
    if not text:
        return None
    # 去掉可能的代码围栏
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except Exception:
        pass
    for pat in (r"\[.*\]", r"\{.*\}"):
        m = re.search(pat, text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None


class Controller:
    def __init__(self):
        self.cfg = load_config()
        os.makedirs(WORLD_DIR, exist_ok=True)
        os.makedirs(MEMORY_DIR, exist_ok=True)
        os.makedirs(BACKUP_DIR, exist_ok=True)
        self.migrate_old_profiles()
        self.mode = "worlds"      # worlds | game
        self.profile = None       # 当前世界档案
        self.history = []         # 当前世界记忆
        self.saved_at = ""
        self.last_op = "init"
        self.last_assist = None
        self.char_cache = None   # {"wid": str, "names": {名字: 性别}}
        # 访问码（手机远程访问用；本机 127.0.0.1 访问无需）
        code = os.environ.get("WX_CODE") or self.cfg.get("access_code") or ""
        if not code:
            code = "%06d" % random.randrange(1000000)
            self.cfg["access_code"] = code
            self.save_config()
        self.access_code = code
        self.lock = threading.Lock()

    # ---------- 数据迁移（旧版 profiles → worlds） ----------

    def migrate_old_profiles(self):
        old_dir = os.path.join(DATA_DIR, "profiles")
        if not os.path.isdir(old_dir):
            return
        for f in os.listdir(old_dir):
            if not f.endswith(".json"):
                continue
            dst = os.path.join(WORLD_DIR, f)
            if os.path.exists(dst):
                continue
            try:
                with open(os.path.join(old_dir, f), "r", encoding="utf-8") as fh:
                    p = json.load(fh)
                p.setdefault("id", f[:-5])
                with open(dst, "w", encoding="utf-8") as fh:
                    json.dump(p, fh, ensure_ascii=False, indent=2)
            except Exception:
                pass

    # ---------- 世界档案 ----------

    def world_path(self, wid):
        return os.path.join(WORLD_DIR, wid + ".json")

    def load_world(self, wid):
        try:
            with open(self.world_path(wid), "r", encoding="utf-8") as f:
                p = json.load(f)
            for k in PROFILE_KEYS:
                p.setdefault(k, "")
            p["id"] = wid
            return p
        except Exception:
            return None

    def list_worlds(self):
        result = []
        for f in os.listdir(WORLD_DIR):
            if not f.endswith(".json"):
                continue
            wid = f[:-5]
            p = self.load_world(wid)
            if not p:
                continue
            mem = self.load_memory(wid)
            result.append({
                "id": wid,
                "name": p.get("name", "未命名"),
                "desc": p.get("desc", ""),
                "count": len(mem) if mem else 0,
                "updated_at": self.memory_time(wid),
            })
        result.sort(key=lambda w: w["updated_at"], reverse=True)
        return result

    def save_world(self, p):
        wid = p.get("id") or ("w" + uuid.uuid4().hex[:8])
        p = dict(p)
        p["id"] = wid
        p.setdefault("created_at", int(time.time()))
        with open(self.world_path(wid), "w", encoding="utf-8") as f:
            json.dump(p, f, ensure_ascii=False, indent=2)
        return wid

    def delete_world(self, wid):
        self.backup_memory(wid, note="删除世界前自动备份")
        for path in (self.world_path(wid), os.path.join(MEMORY_DIR, wid + ".json")):
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass

    # ---------- 记忆（自动保存） ----------

    def memory_path(self, wid):
        return os.path.join(MEMORY_DIR, wid + ".json")

    def load_memory(self, wid):
        try:
            with open(self.memory_path(wid), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("history") or []
        except Exception:
            return None

    def memory_time(self, wid):
        try:
            return int(os.path.getmtime(self.memory_path(wid)))
        except Exception:
            return 0

    def save_memory(self):
        if not self.profile:
            return
        wid = self.profile["id"]
        with open(self.memory_path(wid), "w", encoding="utf-8") as f:
            json.dump({"updated_at": int(time.time()), "history": self.history},
                      f, ensure_ascii=False, indent=2)
        self.saved_at = time.strftime("%H:%M:%S")

    def backup_memory(self, wid, note="自动备份"):
        mem = self.load_memory(wid)
        if not mem:
            return
        ts = time.strftime("%Y%m%d_%H%M%S")
        path = os.path.join(BACKUP_DIR, f"{wid}_{ts}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"note": note, "profile": self.load_world(wid),
                       "history": mem, "backed_up_at": ts}, f, ensure_ascii=False, indent=2)

    # ---------- AI ----------

    def system_prompt(self, len_override=None):
        p = self.profile or {}
        lv = str(p.get("realism", "2")).strip() or "2"
        if lv not in REALISM_RULES:
            lv = "2"
        lv_len = str(p.get("output_len", "2")).strip() or "2"
        len_rule = len_override or LEN_RULES.get(lv_len, "300~600")
        show = str(p.get("show_status", "1")).strip()
        tier = str(p.get("status_detail", "3")).strip()
        if tier not in STATUS_TIERS:
            tier = "3"
        quota = STATUS_TIERS[tier]["quota"]
        is_xianxia = str(p.get("preset", "")).strip() == "xianxia"
        if show == "0":
            status_rule = "关闭：回复中不要输出任何状态块。"
        elif tier == "1":
            status_rule = (
                "开启（精简档）：每次回复末尾（正文之后）必须输出一个【世界状态】块，并用空行与正文隔开。\n"
                "【栏目自定·由你按世界观设计】依据本世界观自行决定栏目（修仙可用境界／修为／灵石，宫廷可用位分／圣宠，"
                "末世可用物资／体力／感染度，校园可用成绩／声望……），并在后续回复中保持一致。\n"
                "【必含三大类】① 世界状态：时间、地点、环境与该世界特有的世界级动向；"
                "② 人物状态：主角的处境、身体、心境、资源与目标；③ 人际关系：相关人物每人一行，"
                "含关系阶段、当前态度、好感 0~100。数值须与正文严格一致、升易降难、不可剧变。\n"
                "格式示例：\n【世界状态】\n时间：…｜地点：…\n环境：…\n世界：…\n我：…\n人物名（关系 N）：当前态度")
        elif is_xianxia:
            status_rule = XIANXIA_STATUS_RULE.replace("2000 字", str(quota) + " 字")
        else:
            status_rule = (
                "开启（" + STATUS_TIERS[tier]["label"] + "）：每次回复末尾（正文之后）必须输出一个【世界状态】块，"
                "并用空行与正文隔开。\n"
                "A.【篇幅硬性要求】状态块本身不得少于 " + str(quota) + " 字——要写得详实、有层次，"
                "用小标题分段展开，绝不能一两行了事、也不能用空话凑数。\n"
                "B.【栏目自定·由你按世界观设计】依据本世界观自行决定状态栏目，不同世界完全不同："
                "修仙可用「境界／修为／灵石／功法／宗门」，宫廷可用「位分／圣宠／权柄／宫中势力」，"
                "末世可用「物资／体力／感染度／据点」，校园可用「成绩／声望／体力／社团」，"
                "商战可用「资产／人脉／商誉／把柄」……栏目名与数值由你按世界观合理设定，"
                "并在后续回复中保持一致（不要每轮换花样）。\n"
                "C.【必含三大类，每类都要展开写】\n"
                "■ 世界状态：时间、地点、天象节气、环境细节，以及该世界观特有的世界级信息"
                "（天下大势、势力动向、传闻风声、灾祸与机遇）；写清「现状 → 变化原因 → 对后续的影响」。\n"
                "■ 人物状态：主角的处境、身体与伤势、心境与情绪、资源（钱物/装备/权限）、当前目标与困境、"
                "近期所做之事的后果。\n"
                "■ 人际关系：每个相关人物单独一段，写清关系阶段与身份、当前态度、好感 0~100 及其缘由、"
                "隐藏的心思与立场、与主角的过往纠葛、今后可能的走向。\n"
                "D.【一致性】所有栏目、数值与关系必须与正文剧情严格一致、前后连贯；好感升易降难、不可剧变；"
                "只写实情，不写空话套话。\n"
                "格式骨架（栏目名按你的世界观替换）：\n【世界状态】\n■ 世界状态\n…\n■ 人物状态\n…\n"
                "■ 人际关系\n人物名（好感 N）：…")
        # 当前状态档位（供后续兜底使用）
        self._status_quota = quota
        self._status_tier = tier
        # 行动选项
        opts_on = str(p.get("options_on", "0")).strip()
        if opts_on != "1":
            option_rule = "关闭：不要输出行动选项。"
        else:
            n = str(p.get("options_count", "3")).strip()
            if not n.isdigit() or not (2 <= int(n) <= 7):
                n = "3"
            ol = str(p.get("options_len", "2")).strip()
            len_desc = OPTION_LEN_RULES.get(ol, OPTION_LEN_RULES["2"])
            option_rule = ("开启：每次回复末尾（若有状态块，则在其之后）必须输出行动选项块，"
                           "格式必须严格如下（第一行固定是【行动选项】单独成行，绝不可省略）：\n"
                           "【行动选项】\n"
                           "1. 选项一\n2. 选项二\n……共 " + n + " 个选项，文本长度：" + len_desc + "。"
                           "每个选项必须贴合当前剧情与人物性格，彼此差异明显，覆盖不同方向"
                           "（如推进剧情、对话、观察、试探、离开等），不要加额外说明或空话。")
        return SYSTEM_TEMPLATE.format(
            name=p.get("name", ""), desc=p.get("desc", ""), world=p.get("world", ""),
            protagonist=p.get("protagonist", ""), characters=p.get("characters", ""),
            style=p.get("style", ""), rules=p.get("rules", ""),
            realism=REALISM_LABELS[lv] + "（第" + lv + "档）",
            realism_label=REALISM_LABELS[lv],
            realism_rule=REALISM_RULES[lv],
            len_rule=len_rule,
            status_rule=status_rule,
            option_rule=option_rule,
            preset_rule=(XIANXIA_RULES if is_xianxia else ""))

    def call_llm(self, messages, max_tokens=None):
        return llm.chat(messages, self.cfg, max_tokens=max_tokens)

    # ---------- 长文分段生成（提示词/输出过长时自动分多次请求并合并） ----------

    def _chunk_cfg(self):
        c = self.cfg.get("chunk") or {}
        try:
            part = int(c.get("part_chars", 1200) or 1200)
        except (TypeError, ValueError):
            part = 1200
        try:
            mx = int(c.get("max_parts", 4) or 4)
        except (TypeError, ValueError):
            mx = 4
        return {"enabled": bool(c.get("enabled", True)),
                "part_chars": max(300, min(4000, part)),
                "max_parts": max(1, min(8, mx))}

    def _target_chars(self):
        lv = str((self.profile or {}).get("output_len", "2")).strip() or "2"
        return LEN_TARGET_CHARS.get(lv, 600)

    def _active_model(self):
        pid = str(self.cfg.get("active_text", ""))
        p = (self.cfg.get("providers", {}) or {}).get(pid) or {}
        return pid, str(p.get("model", ""))

    def _single_call_cap(self):
        pid, model = self._active_model()
        return single_call_cap(pid, model)

    def _chunk_mode(self):
        """分段模式：auto=按模型能力自动判断（默认）/ off=始终一次写完 / on=强制分段。"""
        m = str((self.cfg.get("chunk") or {}).get("mode", "auto")).strip()
        return m if m in ("auto", "off", "on") else "auto"

    def _trim_msgs(self, msgs, budget=24000):
        """提示词过长时压缩：保留系统设定与最近剧情，折叠早期内容。"""
        total = sum(len(str(m.get("content", ""))) for m in msgs)
        if total <= budget:
            return msgs
        out = list(msgs)
        while len(out) > 2 and sum(len(str(m.get("content", ""))) for m in out) > budget:
            out.pop(1)
        if len(out) > 1 and out[0].get("role") == "system":
            out.insert(1, {"role": "user",
                           "content": "（更早的剧情因篇幅已省略；请依据世界档案与最近的剧情，保持连贯地继续。）"})
        return out

    def _append_block(self, base_msgs, text, kind):
        """让模型只补一个板块（状态/行动选项），用于弱模型漏输出时兜底。"""
        p = self.profile or {}
        if kind == "status":
            quota = getattr(self, "_status_quota", 2000) or 2000
            ask = ("请只输出这一幕结束时的【世界状态】块（第一行必须是【世界状态】，单独成行），"
                   "整块不少于 " + str(quota) + " 字。"
                   "必须包含三大类：① 世界状态（时间／地点／环境／该世界特有的世界级动向）；"
                   "② 人物状态（主角的处境／身体／心境／资源与目标）；"
                   "③ 人际关系（每个相关人物一段，含关系阶段、当前态度、好感 0~100 及缘由）。"
                   "栏目名与数值必须贴合本世界观，并与上文剧情严格一致、简洁写实。"
                   "不要重复正文，不要输出【世界状态】以外的任何内容。")
        else:
            n = str(p.get("options_count", "3")).strip()
            if not n.isdigit() or not (2 <= int(n) <= 7):
                n = "3"
            ol = OPTION_LEN_RULES.get(str(p.get("options_len", "2")).strip(), OPTION_LEN_RULES["2"])
            ask = ("请只输出行动选项块（第一行必须是【行动选项】，单独成行），"
                   "给出 " + n + " 个编号选项，文本长度：" + ol +
                   "；每个选项都要贴合上文剧情与人物性格，方向各异（推进剧情／对话／观察／试探／离开等）。"
                   "不要重复正文，不要输出【行动选项】以外的任何内容。")
        marker = "【世界状态】" if kind == "status" else "【行动选项】"
        try:
            res = self.call_llm(list(base_msgs) +
                                [{"role": "assistant", "content": text[-3000:]},
                                 {"role": "user", "content": ask}])
            extra = (res.get("content") or "").strip()
        except Exception:
            extra = ""
        if not extra:
            return text
        if marker not in extra:
            extra = marker + "\n" + extra
        return text.rstrip() + "\n\n" + extra

    def _status_block_len(self, text):
        """返回【世界状态】块的字数（不含行动选项）。"""
        i = text.find("【世界状态】")
        if i < 0:
            return 0
        j = text.find("【行动选项】")
        seg = text[i:j] if (j > i) else text[i:]
        return len(seg.strip())

    def _narr_len(self, text):
        """返回故事正文（状态块与行动选项之前的部分）的字数。"""
        i = text.find("【世界状态】")
        if i < 0:
            i = text.find("【行动选项】")
        return len((text[:i] if i >= 0 else text).strip())

    def _tier_bounds(self):
        """返回 (正文下限, 正文上限, 状态块配额)。"""
        p = self.profile or {}
        lv = str(p.get("output_len", "2")).strip() or "2"
        rule = str(LEN_RULES.get(lv, "300~600"))
        try:
            lo, hi = [int(x) for x in rule.replace("～", "~").split("~")[:2]]
        except Exception:
            lo, hi = 300, 600
        tier = str(p.get("status_detail", "3")).strip()
        if tier not in STATUS_TIERS:
            tier = "3"
        quota = STATUS_TIERS[tier]["quota"]
        if str(p.get("show_status", "1")).strip() == "0":
            quota = 0
        return lo, hi, quota

    def _trim_status(self, text, quota):
        """状态块明显超标时，收敛到档位附近（按段落边界截断）。"""
        i = text.find("【世界状态】")
        if i < 0 or quota <= 0:
            return text
        j = text.find("【行动选项】")
        head = text[:i].rstrip()
        block = text[i:j].strip() if j > i else text[i:].strip()
        tail = text[j:].strip() if j > i else ""
        limit = int(quota * 1.15)
        if len(block) <= limit:
            return text
        lines = block.split("\n")
        keep = []
        total = 0
        for ln in lines:
            if total >= limit:
                break
            keep.append(ln)
            total += len(ln) + 1
        newblock = "\n".join(keep).rstrip()
        if not newblock.startswith("【世界状态】"):
            newblock = "【世界状态】\n" + newblock
        out = head + "\n\n" + newblock
        if tail:
            out += "\n\n" + tail
        return out

    def _ensure_narrative(self, base_msgs, text, target):
        """正文（故事与对话）不足档位下限时，续写一次补足。"""
        lo, hi, _q = self._tier_bounds()
        cur = self._narr_len(text)
        if cur >= lo * 0.9:
            return text
        need = max(200, lo - cur)
        i = text.find("【世界状态】")
        head = text[:i].rstrip() if i >= 0 else text.rstrip()
        tail = text[i:].strip() if i >= 0 else ""
        ask = ("【补足正文】上面这一幕的故事正文还不够长（现在约 %d 字，本档要求 %d~%d 字）。"
               "请紧接上文继续往下写，再补约 %d 字；只写故事正文与对话，"
               "不要重复已经写过的内容，不要输出【世界状态】与【行动选项】，也不要写思考过程。"
               % (cur, lo, hi, need))
        try:
            res = self.call_llm(list(base_msgs) +
                                [{"role": "assistant", "content": head[-3000:]},
                                 {"role": "user", "content": ask}],
                                max_tokens=max(1200, min(32000, int(need * 2.0) + 500)))
            add, _th = llm.split_thinking(res.get("content") or "")
        except Exception:
            add = ""
        if not add or len(add) < 40:
            return text
        out = head + "\n\n" + add.strip()
        if tail:
            out += "\n\n" + tail
        return out.strip()

    def _gen_status_section(self, base_msgs, text, title, spec, quota=700):
        """分节生成状态块内容：不足 quota 字才续写，且不无限加长。"""
        piece = ""
        cap = int(quota * 1.35)          # 单节上限，避免累加超标
        for attempt in range(3):
            if attempt == 0:
                ask = ("请只写这一幕状态块的「" + title + "」部分，约 " + str(quota) + " 字"
                       "（不要少于 " + str(int(quota * 0.8)) + " 字，也不要超过 " + str(cap) + " 字）。\n"
                       "要求：" + spec + "\n"
                       "用小段落分层展开，内容具体写实，不要空话套话；"
                       "只输出这一部分的正文，不要输出【世界状态】标题、不要写其他部分、不要输出【行动选项】。")
            else:
                ask = ("上面的「" + title + "」还不够长，请继续往下补写（不要重复已写内容），"
                       "再补约 " + str(max(100, quota - len(piece))) + " 字即可，"
                       "补到 " + str(int(quota * 0.8)) + " 字以上就停，不要超过 " + str(cap) + " 字。")
            msgs = list(base_msgs) + [{"role": "assistant", "content": text[-3000:]}]
            if piece:
                msgs.append({"role": "assistant", "content": piece})
            msgs.append({"role": "user", "content": ask})
            try:
                res = self.call_llm(msgs)
                got = (res.get("content") or "").strip()
            except Exception:
                break
            if not got:
                break
            piece = (piece + "\n" + got).strip() if piece else got
            if len(piece) >= quota * 0.8:
                break
        if len(piece) > cap:
            lines = piece.split("\n")
            keep, total = [], 0
            for ln in lines:
                if total >= cap:
                    break
                keep.append(ln)
                total += len(ln) + 1
            piece = "\n".join(keep).rstrip()
        return piece

    def _expand_status(self, base_msgs, text, quota=2000):
        """状态块不足档位篇幅时，按「世界状态／人物状态／人际关系」三节分别生成再拼合。"""
        p = self.profile or {}
        per = max(120, quota // 3)
        is_xianxia = str(p.get("preset", "")).strip() == "xianxia"
        if is_xianxia:
            sections = [
                ("世界状态", "写清时间、地点、天象节气、环境细节，以及天下大势、宗门动向、"
                          "坊间传闻、灾祸与机遇；每项都用「现状 → 变化原因 → 对后续的影响」的方式展开。"),
                ("人物状态", "写清主角的境界、修为进度、灵石、功法法宝、丹药、身体与伤势、"
                          "心境情绪、当前目标与困境、近期行为的后果。"),
                ("人际关系", "对每个相关人物单独一段：身份与关系阶段、当前态度、好感 0~100 及其缘由、"
                          "隐藏的心思与立场、与主角的过往纠葛、今后可能的走向。"),
            ]
        else:
            sections = [
                ("世界状态", "写清时间、地点、天象节气、环境细节，以及本世界观特有的世界级动向"
                          "（天下大势、势力格局、传闻风声、灾祸与机遇）；"
                          "每项都用「现状 → 变化原因 → 对后续的影响」的方式展开。"),
                ("人物状态", "写清主角的处境、身体与伤势、心境与情绪、资源与钱物、当前目标与困境、"
                          "近期所做之事的后果，以及身体上的细节感受。"),
                ("人际关系", "对每个相关人物单独一段：身份与关系阶段、当前态度、好感 0~100 及其缘由、"
                          "隐藏的心思与立场、与主角的过往纠葛、今后可能的走向。"),
            ]
        parts = []
        for title, spec in sections:
            piece = self._gen_status_section(base_msgs, text, title, spec, quota=per)
            if piece:
                parts.append("■ " + title + "\n" + piece)
        if not parts:
            return text
        new_block = "【世界状态】\n" + "\n\n".join(parts)
        i = text.find("【世界状态】")
        j = text.find("【行动选项】")
        head = text[:i].rstrip() if i > 0 else text.rstrip()
        tail = text[j:].strip() if (j > i >= 0) else ""
        out = head + "\n\n" + new_block
        if tail:
            out += "\n\n" + tail
        return out

    def _finalize_reply(self, base_msgs, text):
        """保证每次回复都带足量的状态块（开启时），行动选项同理。"""
        p = self.profile or {}
        status_on = str(p.get("show_status", "1")).strip() != "0"
        tier = str(p.get("status_detail", "3")).strip()
        if tier not in STATUS_TIERS:
            tier = "3"
        quota = STATUS_TIERS[tier]["quota"]
        if status_on:
            if "【世界状态】" not in text:
                text = self._append_block(base_msgs, text, "status")
            if tier != "1" and quota:
                blen = self._status_block_len(text)
                if blen < quota * 0.7:
                    text = self._expand_status(base_msgs, text, quota)
                    blen = self._status_block_len(text)
                # 状态块明显超标时收敛到档位附近，避免"状态比正文还长"
                if blen > quota * 1.5:
                    text = self._trim_status(text, quota)
        if str(p.get("options_on", "0")).strip() == "1" and "【行动选项】" not in text:
            text = self._append_block(base_msgs, text, "options")
        return text

    def generate_reply(self, extra_msgs, target_chars=None):
        """生成一段剧情；需要时自动拆成多次请求并合并成一段完整文本。"""
        base = self._trim_msgs(
            [{"role": "system", "content": self.system_prompt()}] +
            self.send_msgs()[-30:] + list(extra_msgs or []))
        ck = self._chunk_cfg()
        target = target_chars if target_chars else self._target_chars()
        # 输出额度要同时容下"故事正文 + 状态块"，否则正文会被挤短
        lo_n, hi_n, squota = self._tier_bounds()
        tok = max(1200, min(32000, int((target + squota) * 1.8) + 400))
        mode = self._chunk_mode()
        cap = self._single_call_cap()
        need_split = ck["enabled"] and (mode == "on" or (mode == "auto" and target > cap))
        if not need_split:
            # 付费强模型走这里：一次写完，不分段
            res = self.call_llm(base, max_tokens=tok)
            txt = self._finalize_reply(base, res.get("content", ""))
            res["content"] = self._ensure_narrative(base, txt, target)
            return res
        n = int((target + ck["part_chars"] - 1) // ck["part_chars"])
        n = max(1, min(ck["max_parts"], n))
        if n <= 1:
            res = self.call_llm(base, max_tokens=tok)
            txt = self._finalize_reply(base, res.get("content", ""))
            res["content"] = self._ensure_narrative(base, txt, target)
            return res
        parts = []
        reasoning = ""
        per = max(300, int(target / n))          # 每段配额：按整篇目标均分
        lo, hi = int(per * 0.85), int(per * 1.15)
        # 分段写作时，把系统提示里的"每次回复字数"改写为"每段配额"，避免每段都写成一整篇
        split_rule = ("本次回复由 %d 段合并而成，你只写其中一段：每段约 %d 字（%d~%d 字），"
                      "全篇合计约 %d 字。" % (n, per, lo, hi, target))
        base = self._trim_msgs(
            [{"role": "system", "content": self.system_prompt(len_override=split_rule)}] +
            self.send_msgs()[-30:] + list(extra_msgs or []))
        for i in range(n):
            is_last = (i == n - 1)
            msgs = list(base)
            if parts:
                msgs.append({"role": "assistant", "content": "\n\n".join(parts)})
            if is_last:
                ask = ("【分段写作·最后一段（第%d段/共%d段）】整篇剧情的目标总长度约 %d 字，"
                       "前 %d 段已写约 %d 字，本段请再写约 %d 字（%d~%d 字）把剧情收束，"
                       "然后按规矩输出【世界状态】（若已开启）与【行动选项】（若已开启）；"
                       "不要重复已经写过的内容，也不要超出这个字数太多。"
                       % (i + 1, n, target, n - 1, sum(len(x) for x in parts), per, lo, hi))
            else:
                ask = ("【分段写作·第%d段/共%d段】整篇剧情的目标总长度约 %d 字，本段只写约 %d 字"
                       "（严格控制在 %d~%d 字；系统提示中的字数是整篇总量，不是本段），"
                       "本轮只写正文，不要输出【世界状态】与【行动选项】，"
                       "也不要在本段收尾，在情节自然停顿处结束；不要重复已写内容，更不要写成一整篇。"
                       % (i + 1, n, target, per, lo, hi))
            res = self.call_llm(msgs + [{"role": "user", "content": ask}],
                                max_tokens=max(1200, min(32000, int(per * 2.2) + 300)))
            text = (res.get("content") or "").strip()
            if text:
                parts.append(text)
            if not reasoning and res.get("reasoning"):
                reasoning = res["reasoning"]
        merged = "\n\n".join(parts).strip()
        merged = self._finalize_reply(base, merged)
        merged = self._ensure_narrative(base, merged, target)
        return {"content": merged, "reasoning": reasoning}

    def send_msgs(self):
        # AI 上下文只取文字消息，图片消息不参与
        return [{"role": m["role"], "content": m["content"]}
                for m in self.history if m["role"] in ("user", "assistant")]

    # ---------- 入口 ----------

    def do_dump_all(self):
        """导出全部世界与记忆（供浏览器本地存档）。"""
        data = {"worlds": {}, "memories": {},
                "current_id": (self.profile or {}).get("id", ""), "updated_at": 0}
        try:
            for fn in os.listdir(WORLD_DIR):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(WORLD_DIR, fn), "r", encoding="utf-8") as f:
                        data["worlds"][fn[:-5]] = json.load(f)
                except Exception:
                    pass
            for fn in os.listdir(MEMORY_DIR):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(MEMORY_DIR, fn), "r", encoding="utf-8") as f:
                        m = json.load(f)
                    data["memories"][fn[:-5]] = m
                    data["updated_at"] = max(data["updated_at"], int(m.get("updated_at", 0)))
                except Exception:
                    pass
        except Exception:
            pass
        self.last_assist = {"field": "dump_all", **data}
        self.last_op = "dump_all"

    def do_restore_all(self, blob):
        """从浏览器本地存档恢复全部世界与记忆。"""
        blob = blob if isinstance(blob, dict) else {}
        worlds = blob.get("worlds") if isinstance(blob.get("worlds"), dict) else {}
        memories = blob.get("memories") if isinstance(blob.get("memories"), dict) else {}
        n_w = n_m = 0
        try:
            for wid, prof in worlds.items():
                if isinstance(prof, dict) and prof.get("id"):
                    with open(os.path.join(WORLD_DIR, str(prof["id"]) + ".json"),
                              "w", encoding="utf-8", newline="\n") as f:
                        json.dump(prof, f, ensure_ascii=False, indent=2)
                    n_w += 1
            for wid, mem in memories.items():
                if isinstance(mem, dict) and "history" in mem:
                    with open(os.path.join(MEMORY_DIR, str(wid) + ".json"),
                              "w", encoding="utf-8", newline="\n") as f:
                        json.dump(mem, f, ensure_ascii=False, indent=2)
                    n_m += 1
            if worlds:
                target = blob.get("current_id") or next(iter(worlds))
                prof = self.load_world(target) or {}
                self.profile = prof if prof.get("id") else None
                self.mode = "game" if self.profile else "worlds"
                if self.profile and os.path.exists(self.memory_path(target)):
                    self.history = self.load_memory(target) or []
        except Exception as e:
            self.last_assist = {"field": "restore_all", "ok": False, "error": str(e)[:80]}
            return
        self.last_assist = {"field": "restore_all", "ok": True,
                            "worlds": n_w, "memories": n_m}
        self.last_op = "restore_all"

    def handle(self, payload, code=None, local=False):
        # 远程访问需要访问码；本机访问免码
        if (not local) and self.access_code and code != self.access_code:
            return json.dumps({"error": "need_code"}, ensure_ascii=False).encode("utf-8")
        with self.lock:
            action = payload.get("action", "state")
            self.last_assist = None
            try:
                if action == "dump_all":
                    self.do_dump_all()
                elif action == "restore_all":
                    self.do_restore_all(payload.get("data"))
                elif action == "world_create":
                    self.do_world_create(payload.get("profile"))
                elif action == "world_open":
                    self.do_world_open(payload.get("id", ""))
                elif action == "world_edit":
                    self.do_world_edit(payload.get("profile"))
                elif action == "world_delete":
                    self.do_world_delete(payload.get("id", ""))
                elif action == "back_to_worlds":
                    self.mode = "worlds"
                    self.last_op = "back"
                elif action == "start":
                    self.do_start()
                elif action == "say":
                    self.do_say(payload.get("text", ""))
                elif action == "regenerate":
                    self.do_regenerate()
                elif action == "restart":
                    self.do_restart()
                elif action == "ai_assist":
                    self.do_ai_assist(payload.get("field", ""), payload.get("draft"))
                elif action == "ai_revise":
                    self.do_ai_revise(payload.get("fields"), payload.get("instruction", ""), payload.get("draft"))
                elif action == "set_realism":
                    self.do_set_realism(payload.get("level"))
                elif action == "set_output":
                    self.do_set_output(payload.get("output_len"), payload.get("show_status"),
                                       payload.get("status_detail"), payload.get("options_on"),
                                       payload.get("options_count"), payload.get("options_len"))
                elif action == "ai_discuss":
                    self.do_ai_discuss(payload.get("text", ""), payload.get("draft"))
                elif action == "settings":
                    self.do_settings(payload.get("show_reasoning"))
                elif action == "providers_save":
                    self.do_providers_save(payload.get("providers"),
                                           payload.get("active_text"),
                                           payload.get("active_image"))
                elif action == "list_models":
                    self.do_list_models(payload.get("provider"))
                elif action == "cultivation_preset":
                    self.do_cultivation_preset()
                elif action == "free_mode":
                    self.do_free_mode()
                elif action == "chunk_save":
                    self.do_chunk_save(payload.get("enabled"), payload.get("part_chars"),
                                       payload.get("max_parts"), payload.get("mode"))
                elif action == "test_api":
                    self.do_test_api(payload.get("provider"))
                elif action == "image_gen":
                    self.do_image_gen(payload.get("prompt", ""),
                                      payload.get("use_context", True))
                elif action == "delete_msg":
                    self.do_delete_msg(payload.get("index"))
                elif action == "world_rename":
                    self.do_world_rename(payload.get("id", ""), payload.get("name", ""))
                elif action == "tts_split":
                    self.do_tts_split(payload.get("text", ""),
                                      payload.get("females"), payload.get("males"))
                elif action == "char_voices":
                    self.do_char_voices()
                elif action == "tts_voices_save":
                    self.do_tts_voices_save(payload.get("tts_voices"))
                return self.render()
            except llm.LLMError as e:
                return self.render(error=str(e))
            except Exception as e:
                return self.render(error=f"出错了：{e}")

    def render(self, error=None):
        current = None
        if self.mode == "game" and self.profile:
            current = {
                "profile": self.profile,
                "history": self.history[-120:],
                "has_memory": bool(self.history),
                "hist_offset": max(0, len(self.history) - 120),
            }
        return {
            "mode": self.mode,
            "worlds": self.list_worlds(),
            "current": current,
            "settings": {"show_reasoning": bool(self.cfg.get("show_reasoning", True)),
                         "api_ready": llm.api_ready(self.cfg),
                         "img_ready": llm.image_ready(self.cfg),
                         "access_code": self.access_code,
                         "chunk": self._chunk_cfg(),
                         "chunk_mode": self._chunk_mode(),
                         "single_cap": self._single_call_cap(),
                         "active_model": self._active_model()[1]},
            "providers": self.cfg.get("providers", {}),
            "active_text": self.cfg.get("active_text", ""),
            "active_image": self.cfg.get("active_image", ""),
            "tts_voices": {k: self.voice_spec(k) for k in SLOT_ORDER},
            "saved_at": self.saved_at,
            "assist": self.last_assist,
            "op": self.last_op,
            "error": error,
        }

    # ---------- 世界管理 ----------

    def do_world_create(self, profile):
        if not isinstance(profile, dict):
            return
        p = {}
        for k in PROFILE_KEYS:
            p[k] = str(profile.get(k, "") or "").strip()
        p["name"] = p["name"] or "未命名世界"
        lv = str(profile.get("realism", "2")).strip() or "2"
        p["realism"] = lv if lv in REALISM_RULES else "2"
        p["output_len"] = str(profile.get("output_len", "2")).strip() if str(profile.get("output_len", "2")).strip() in LEN_RULES else "2"
        p["show_status"] = "1" if str(profile.get("show_status", "1")).strip() != "0" else "0"
        ptier = str(profile.get("status_detail", "3")).strip()
        p["status_detail"] = ptier if ptier in STATUS_TIERS else "3"
        p["options_on"] = "1" if str(profile.get("options_on", "0")).strip() == "1" else "0"
        oc = str(profile.get("options_count", "3")).strip()
        p["options_count"] = oc if oc.isdigit() and 2 <= int(oc) <= 7 else "3"
        ol = str(profile.get("options_len", "2")).strip()
        p["options_len"] = ol if ol in OPTION_LEN_RULES else "2"
        p["preset"] = str(profile.get("preset", "") or "").strip()[:20]
        wid = self.save_world(p)
        self.profile = self.load_world(wid)
        self.history = []
        self.mode = "game"
        self.saved_at = ""
        self.last_op = "world_create"

    def do_world_open(self, wid):
        p = self.load_world(wid)
        if p is None:
            return
        self.profile = p
        self.history = self.load_memory(wid) or []
        self.mode = "game"
        self.last_op = "world_open"

    def do_world_edit(self, profile):
        if not isinstance(profile, dict) or not self.profile:
            return
        wid = self.profile["id"]
        p = dict(self.profile)
        for k in PROFILE_KEYS:
            if k in profile:
                p[k] = str(profile[k] or "").strip()
        p["name"] = p["name"] or "未命名世界"
        lv = str(profile.get("realism", p.get("realism", "2"))).strip() or "2"
        p["realism"] = lv if lv in REALISM_RULES else "2"
        if "output_len" in profile:
            v = str(profile.get("output_len", "")).strip()
            p["output_len"] = v if v in LEN_RULES else "2"
        if "show_status" in profile:
            p["show_status"] = "1" if str(profile.get("show_status", "1")).strip() != "0" else "0"
        if "status_detail" in profile:
            v = str(profile.get("status_detail", "3")).strip()
            if v in STATUS_TIERS:
                p["status_detail"] = v
        if "options_on" in profile:
            p["options_on"] = "1" if str(profile.get("options_on", "0")).strip() == "1" else "0"
        if "options_count" in profile:
            oc = str(profile.get("options_count", "")).strip()
            if oc.isdigit() and 2 <= int(oc) <= 7:
                p["options_count"] = oc
        if "options_len" in profile:
            ol = str(profile.get("options_len", "")).strip()
            if ol in OPTION_LEN_RULES:
                p["options_len"] = ol
        if "preset" in profile:
            p["preset"] = str(profile.get("preset", "") or "").strip()[:20]
        self.save_world(p)
        self.profile = p
        self.char_cache = None   # 档案变了，角色名单缓存失效
        # 编辑档案不影响记忆
        self.last_op = "world_edit"

    def do_world_delete(self, wid):
        self.delete_world(wid)
        if self.mode == "game" and self.profile and self.profile.get("id") == wid:
            self.profile = None
            self.history = []
            self.mode = "worlds"
        self.last_op = "world_delete"

    # ---------- 游戏 ----------

    def do_start(self):
        if not self.profile:
            return
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置 API：请在 config.json 的 api 里填写 api_key，然后重启本程序。")
        self.last_op = "start"
        self.history = []
        res = self.generate_reply([{"role": "user", "content": OPENING_PROMPT}])
        self.history.append({"role": "assistant", "content": res["content"], "reasoning": res["reasoning"]})
        self.save_memory()
        self._bg_split_later(len(self.history) - 1)
        self._bg_tts_later(len(self.history) - 1)

    def do_say(self, text):
        text = (text or "").strip()
        if not text or not self.profile:
            return
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置 API：请在 config.json 的 api 里填写 api_key，然后重启本程序。")
        self.last_op = "say"
        self.history.append({"role": "user", "content": text, "reasoning": ""})
        res = self.generate_reply([])
        self.history.append({"role": "assistant", "content": res["content"], "reasoning": res["reasoning"]})
        self.save_memory()
        self._bg_split_later(len(self.history) - 1)
        self._bg_tts_later(len(self.history) - 1)

    def do_regenerate(self):
        if not self.profile:
            return
        # 末尾的图片消息先移除，再重写最后一段文字
        while self.history and self.history[-1]["role"] == "image":
            self.history.pop()
        if not self.history or self.history[-1]["role"] != "assistant":
            return
        self.last_op = "regenerate"
        self.history.pop()
        res = self.generate_reply([{"role": "user", "content": REGEN_PROMPT}])
        self.history.append({"role": "assistant", "content": res["content"], "reasoning": res["reasoning"]})
        self.save_memory()
        self._bg_split_later(len(self.history) - 1)
        self._bg_tts_later(len(self.history) - 1)

    def do_restart(self):
        if not self.profile:
            return
        wid = self.profile["id"]
        if self.history:
            self.backup_memory(wid, note="重新开始前自动备份")
        self.history = []
        self.save_memory()
        self.last_op = "restart"

    def do_world_rename(self, wid, name):
        """重命名世界（保留 id 与记忆，只改显示名称）。"""
        name = (name or "").strip()
        if not name:
            return
        p = self.load_world(wid)
        if p is None:
            return
        p["name"] = name[:40]
        self.save_world(p)
        if self.mode == "game" and self.profile and self.profile.get("id") == wid:
            self.profile["name"] = name[:40]
        self.last_op = "world_rename"

    def do_set_realism(self, level):
        """游戏内随时切换真实程度档位。"""
        if not self.profile:
            return
        lv = str(level or "").strip() or "2"
        if lv not in REALISM_RULES:
            lv = "2"
        self.profile["realism"] = lv
        self.save_world(self.profile)
        self.last_op = "set_realism"

    def do_set_output(self, output_len, show_status, status_detail,
                      options_on=None, options_count=None, options_len=None):
        """游戏内随时调整文本输出设置（字数/状态显示/详细度/行动选项）。"""
        if not self.profile:
            return
        if output_len is not None:
            v = str(output_len).strip()
            if v in LEN_RULES:
                self.profile["output_len"] = v
        if show_status is not None:
            self.profile["show_status"] = "1" if str(show_status).strip() != "0" else "0"
        if status_detail is not None:
            v = str(status_detail).strip()
            if v in STATUS_TIERS:
                self.profile["status_detail"] = v
        if options_on is not None:
            self.profile["options_on"] = "1" if str(options_on).strip() == "1" else "0"
        if options_count is not None:
            oc = str(options_count).strip()
            if oc.isdigit() and 2 <= int(oc) <= 7:
                self.profile["options_count"] = oc
        if options_len is not None:
            ol = str(options_len).strip()
            if ol in OPTION_LEN_RULES:
                self.profile["options_len"] = ol
        self.save_world(self.profile)
        self.last_op = "set_output"

    # ---------- 配音：AI 识别角色话语 ----------

    CHAR_PROMPT = (
        "从下面的世界档案中找出所有出场人物，输出他们的名字与性别（男/女）。\n"
        "不要包括旁白或玩家本人；性别不明确的人物按名字和设定推断。\n"
        "输出严格 JSON 数组（不要输出 JSON 以外的任何内容）：\n"
        '[{"name":"月瑶","gender":"女"}]'
    )

    def _get_chars(self, force=False):
        """获取当前世界的角色名单（缓存），返回 {名字: 性别}。"""
        wid = (self.profile or {}).get("id")
        if not wid:
            return {}
        if not force and self.char_cache and self.char_cache.get("wid") == wid:
            return self.char_cache.get("names", {})
        names = {}
        p = self.profile or {}
        info = "\n".join(f"{k}：{p.get(k, '')}" for k in ("desc", "characters", "world")
                          if str(p.get(k, "")).strip())
        if info and llm.api_ready(self.cfg):
            try:
                content = self.CHAR_PROMPT + "\n\n档案：\n" + info[:2000]
                res = self.call_llm([{"role": "system", "content": "你是角色分析助手。"},
                                     {"role": "user", "content": content}])
                chars = self._parse_characters(res["content"])
                if not chars:
                    res2 = self.call_llm([{"role": "system", "content": "你是角色分析助手。"},
                                          {"role": "user", "content": content},
                                          {"role": "assistant", "content": res["content"][-1200:]},
                                          {"role": "user", "content": "请重新输出：只输出一个合法的 JSON 数组，不要任何其他文字。"}])
                    chars = self._parse_characters(res2["content"])
                for ch in chars:
                    names[ch["name"]] = ch["gender"]
            except Exception:
                pass
        self.char_cache = {"wid": wid, "names": names}
        return names

    def do_char_voices(self):
        """分析当前世界档案，找出所有出场人物的名字与性别（服务端缓存）。"""
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置对话 API 密钥，无法识别角色")
        names = self._get_chars()
        chars = [{"name": n, "gender": g} for n, g in names.items()]
        self.last_op = "char_voices"
        self.last_assist = {"field": "char_voices", "characters": chars[:20]}

    @staticmethod
    def _parse_characters(text):
        chars = []
        obj = parse_json(text)
        if isinstance(obj, list):
            for it in obj:
                if isinstance(it, dict) and str(it.get("name", "")).strip():
                    g = str(it.get("gender") or "").strip()
                    if g not in ("男", "女"):
                        g = "女"
                    chars.append({"name": str(it["name"])[:20], "gender": g})
        return chars

    def _split_text(self, text, names=None):
        """把文本切分为角色片段（返回 segments 列表）。"""
        names = names or {}
        females = [n for n, g in names.items() if g == "女"][:8]
        males = [n for n, g in names.items() if g == "男"][:8]
        names_note = ""
        if females:
            names_note += "女性角色名单：" + "、".join(females) + "。名单内女性角色的对话必须标注为该角色的【名字】。\n"
        else:
            names_note += "女性角色的对话按出场顺序标注：第一位女性 → 女主1，第二位 → 女主2，第三位 → 女主3，以此类推。\n"
        if males:
            names_note += "男性角色名单：" + "、".join(males) + "。名单内男性角色的对话必须标注为该角色的【名字】。\n"
        else:
            names_note += "男性角色（玩家除外）的对话标注为 男配。\n"
        prompt = (
            "你是配音导演。把下面这段小说文本切分成若干连续片段，并为每段标注应由谁朗读。\n"
            "【必须遵守】\n"
            "1. 引号「」或“”内的每一句对话，必须单独拆出成段，并标注其说话人，绝不能并入旁白；\n"
            "2. 说话人归类：玩家本人/男主角的台词与心理 → 男主；"
            + names_note +
            "名单之外的其他女性 → 女配；名单之外的其他男性 → 男配；叙述、描写、无主语句子 → 旁白；\n"
            "3. 每段 text 必须是原文的连续片段，不得删改、遗漏或重复，全部段落按顺序拼起来就是原文。\n"
            "示例：原文「她道：“你来了。”你点点头。」应输出：\n"
            '[{"role":"旁白","text":"她道："},{"role":"月瑶","text":"你来了。"},{"role":"旁白","text":"你点点头。"}]\n'
            "输出严格 JSON 数组（不要输出 JSON 以外的任何内容）。"
        )
        content = prompt + "\n\n文本：\n" + text[:3000]
        res = self.call_llm([{"role": "system", "content": "你是专业的配音导演，擅长为小说文本标注角色。"},
                             {"role": "user", "content": content}])
        obj = parse_json(res["content"])
        if obj is None or not isinstance(obj, list):
            try:
                res2 = self.call_llm([{"role": "system", "content": "你是专业的配音导演。"},
                                      {"role": "user", "content": content},
                                      {"role": "assistant", "content": res["content"][-1500:]},
                                      {"role": "user", "content": "请重新输出：只输出一个合法的 JSON 数组，不要任何其他文字。"}])
                obj = parse_json(res2["content"])
            except Exception:
                obj = None
        allowed = ["旁白", "男主", "女配", "男配"] + females + males
        segs = []
        if isinstance(obj, list):
            for it in obj:
                if isinstance(it, dict) and str(it.get("text", "")).strip():
                    role = str(it.get("role") or "旁白").strip()
                    is_ok = role in allowed or (role.startswith("女主") and role[2:].isdigit())
                    if not is_ok:
                        role = "旁白"
                    segs.append({"role": role, "text": str(it["text"])[:2000]})
        if not segs:
            segs = [{"role": "旁白", "text": text[:3000]}]
        # 直接把声线槽位写死在片段里：客户端只需机械映射，杜绝"名字查不到→同一声音"
        SLOT_MAP = {"旁白": "narrator", "男主": "male1", "男配": "male2", "女配": "female_other"}
        for seg in segs:
            role = seg["role"]
            if role in SLOT_MAP:
                seg["slot"] = SLOT_MAP[role]
            elif role.startswith("女主") and role[2:].isdigit():
                n = int(role[2:])
                seg["slot"] = "f%d" % min(n, 6)
            elif role in females:
                seg["slot"] = "f%d" % min(females.index(role) + 1, 6)
            elif role in males:
                seg["slot"] = "m%d" % min(males.index(role) + 1, 2)
            else:
                seg["slot"] = "female_other"
        return segs

    def do_tts_split(self, text, females=None, males=None):
        text = (text or "").strip()
        if not text:
            return
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置对话 API 密钥，无法识别角色")
        females = [str(x)[:20] for x in (females or []) if str(x).strip()][:8]
        males = [str(x)[:20] for x in (males or []) if str(x).strip()][:8]
        if females or males:
            names = {}
            for n in females:
                names[n] = "女"
            for n in males:
                names[n] = "男"
        else:
            # 客户端未传名单时，用服务端缓存的角色分析
            names = self._get_chars()
        segs = self._split_text(text, names)
        self.last_op = "tts_split"
        self.last_assist = {"field": "tts_split", "segments": segs}

    # ---------- 后台预记录语音分配（生成文本时自动执行） ----------

    def _bg_split_later(self, idx):
        try:
            threading.Thread(target=self._bg_split, args=(idx,), daemon=True).start()
        except Exception:
            pass

    def _bg_split(self, idx):
        try:
            with self.lock:
                if idx >= len(self.history):
                    return
                entry = self.history[idx]
                if entry.get("role") != "assistant" or entry.get("segments") or len(entry.get("content", "")) < 20:
                    return
            names = self._get_chars()
            segs = self._split_text(entry["content"], names)
            with self.lock:
                if idx < len(self.history) and self.history[idx] is entry:
                    entry["segments"] = segs
            self.save_memory()
        except Exception:
            pass

    def _bg_tts_later(self, idx):
        try:
            threading.Thread(target=self._bg_tts, args=(idx,), daemon=True).start()
        except Exception:
            pass

    def _bg_tts(self, idx):
        """后台把整段回复预合成默认声线音频，等用户点朗读时直接秒播。"""
        try:
            with self.lock:
                if idx >= len(self.history):
                    return
                entry = self.history[idx]
                role = entry.get("role")
                content = entry.get("content", "")
            if role != "assistant" or len(content) < 20:
                return
            # 结果只用于填充缓存（失败也不影响主流程）
            self.tts_audio(content, "main")
        except Exception:
            pass

    # ---------- 真实语音合成（Edge 神经语音） ----------

    def voice_spec(self, slot):
        """返回某声线槽位的合成参数（支持用户自定义覆盖）。"""
        key = SLOT_TO_CATALOG.get(slot)
        base = VOICE_CATALOG.get(key) or VOICE_CATALOG["gentle"]
        overrides = self.cfg.get("tts_voices") or {}
        o = overrides.get(key) or {}
        return {
            "key": key,
            "label": base["label"],
            "voice": str(o.get("voice") or base["voice"]),
            "rate": str(o.get("rate") or base["rate"]),
            "pitch": str(o.get("pitch") or base["pitch"]),
        }

    def tts_audio(self, text, slot, voice=None, rate=None, pitch=None):
        """合成一句台词的音频（内存+磁盘缓存），返回 mp3 字节。"""
        text = clean_tts_text(text)
        if not text:
            return None
        spec = self.voice_spec(slot)
        # 试播时允许临时覆盖语音/音调/语速
        if voice and str(voice).strip():
            spec["voice"] = str(voice)[:60]
        if rate and str(rate).strip():
            spec["rate"] = str(rate)[:10]
        if pitch and str(pitch).strip():
            spec["pitch"] = str(pitch)[:10]

        def _signed(s, unit):
            s = str(s or "").strip()
            if not s:
                return "+0" + unit
            if s[0] not in "+-":
                s = "+" + s
            return s[:10]

        spec["rate"] = _signed(spec["rate"], "%")
        spec["pitch"] = _signed(spec["pitch"], "Hz")
        key = spec["voice"] + "|" + spec["rate"] + "|" + spec["pitch"] + "|" + text[:200]
        cache = getattr(self, "_tts_cache", None)
        if cache is None:
            self._tts_cache = {}
            cache = self._tts_cache
        with self.lock:
            if key in cache:
                return cache[key]
        h = hashlib.md5(key.encode("utf-8")).hexdigest()
        os.makedirs(TTS_CACHE_DIR, exist_ok=True)
        path = os.path.join(TTS_CACHE_DIR, h + ".mp3")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            try:
                with open(path, "rb") as f:
                    data = f.read()
                with self.lock:
                    cache[key] = data
                return data
            except Exception:
                pass
        try:
            import asyncio
            import edge_tts

            communicate = edge_tts.Communicate(text, spec["voice"], rate=spec["rate"], pitch=spec["pitch"])

            def _run():
                out = []

                async def _main():
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            out.append(chunk["data"])

                asyncio.run(_main())
                return b"".join(out)

            data = _run()
        except Exception as e:
            tts_log("TTS合成失败 [" + spec["voice"] + " " + spec["rate"] + " " + spec["pitch"] + "]：" + str(e)[:200])
            raise llm.LLMError("语音合成失败：" + str(e)[:100])
        if not data:
            raise llm.LLMError("语音合成返回空音频")
        try:
            with open(path, "wb") as f:
                f.write(data)
        except Exception:
            pass
        with self.lock:
            cache[key] = data
            if len(cache) > 400:
                self._tts_cache = dict(list(cache.items())[-200:])
        return data

    def do_tts_voices_save(self, tts_voices):
        if isinstance(tts_voices, dict):
            clean = {}
            for k, v in tts_voices.items():
                if k in VOICE_CATALOG and isinstance(v, dict):
                    clean[k] = {
                        "voice": str(v.get("voice") or "")[:60],
                        "rate": str(v.get("rate") or "+0%")[:10],
                        "pitch": str(v.get("pitch") or "+0Hz")[:10],
                    }
            self.cfg["tts_voices"] = clean
            self.save_config()
        self.last_op = "tts_voices_save"

    def do_delete_msg(self, index):
        """只删除指定的这一条消息（之后的对话全部保留；自动备份，AI 将不再记得这一条）。"""
        if not self.profile:
            return
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return
        if idx < 0 or idx >= len(self.history):
            return
        self.backup_memory(self.profile["id"], note="删除对话前自动备份")
        self.history.pop(idx)
        self.save_memory()
        self.last_op = "delete_msg"

    # ---------- AI 生成档案 ----------

    def do_ai_assist(self, field, draft):
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置 API：请在 config.json 的 api 里填写 api_key，然后重启本程序。")
        field = field if field in ASSIST_PROMPTS and field != "discuss" else "all"
        draft = draft if isinstance(draft, dict) else {}
        self.last_op = "ai_assist"
        if field == "all":
            name = str(draft.get("name", "") or "").strip() or "未定"
            desc = str(draft.get("desc", "") or "").strip()
            existing = "\n".join(f"{k}：{draft.get(k, '')}" for k in PROFILE_KEYS
                                 if str(draft.get(k, "") or "").strip() and k not in ("name", "desc"))
            content = ("请为一个沉浸式文字冒险世界补全档案。\n"
                       "【核心依据】世界名称与一句话简介是整个世界的灵魂：\n"
                       "名称：" + name + "\n"
                       "简介：" + (desc or "（未填，请完全围绕名称自由发挥）") + "\n"
                       "所有生成的 world/protagonist/characters/style/rules 都必须紧紧围绕这个名称与简介展开，"
                       "与之高度契合、风格统一、细节互相呼应，绝不能跑题。\n"
                       "玩家已填写的其他字段（必须一字不改保留）：\n" + (existing or "（无）") + "\n\n"
                       + ASSIST_PROMPTS["all"])
        else:
            content = build_assist_content(field, draft)
        res = self.call_llm([{"role": "system", "content": ASSIST_SYSTEM},
                            {"role": "user", "content": content}])
        if field == "all":
            obj = parse_json(res["content"])
            if obj is None:
                # 追问一次：要求只输出 JSON
                try:
                    fix = ("你刚才的输出无法解析为合法 JSON。请重新输出：只输出一个合法的 JSON 对象，"
                           "不要输出任何 JSON 以外的文字，字段与要求不变。")
                    res2 = self.call_llm([{"role": "system", "content": ASSIST_SYSTEM},
                                          {"role": "user", "content": content},
                                          {"role": "assistant", "content": res["content"][-2000:]},
                                          {"role": "user", "content": fix}])
                    obj = parse_json(res2["content"])
                except Exception:
                    obj = None
            if obj:
                clean = {k: str(obj.get(k, "") or "") for k in PROFILE_KEYS}
                self.last_assist = {"field": "all", "profile": clean}
            else:
                self.last_assist = {"field": "world", "text": res["content"],
                                    "note": "AI 未按 JSON 输出，内容已追加到世界观栏"}
        else:
            self.last_assist = {"field": field, "text": res["content"]}

    # ---------- AI 按意见修改档案 ----------

    REVISE_FIELDS = ("world", "protagonist", "characters", "style", "rules")

    def do_ai_revise(self, fields, instruction, draft):
        """玩家给修改意见，AI 只改被勾选的栏目，其余一字不动。"""
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置 API：请在 config.json 的 api 里填写 api_key，然后重启本程序。")
        instruction = (instruction or "").strip()
        if not instruction:
            raise llm.LLMError("请先写下你的修改意见")
        draft = draft if isinstance(draft, dict) else {}
        valid = [f for f in self.REVISE_FIELDS if f in (fields or [])]
        if not valid:
            raise llm.LLMError("请至少勾选一个要修改的栏目")
        current = "\n".join(f"{k}：{str(draft.get(k, '') or '') or '（空）'}" for k in valid)
        context = "\n".join(f"{k}：{str(draft.get(k, '') or '') or '（空）'}"
                            for k in ("name", "desc", "world", "protagonist", "characters", "style", "rules")
                            if k not in valid)
        prompt = ("你是文字冒险世界档案的修订助手。\n"
                  "玩家要修改的栏目：" + "、".join(valid) + "\n"
                  "玩家的修改意见：\n" + instruction[:1500] + "\n\n"
                  "【这些栏目当前内容】\n" + current + "\n\n"
                  "【其余栏目（保持不变，仅供你保持一致）】\n" + context + "\n\n"
                  "请按玩家意见重写被选中栏目的内容，要求：\n"
                  "1. 只输出被选中栏目的新内容，其余栏目绝不输出；\n"
                  "2. 与玩家意见无关的原内容尽量保留（小改动为主，不要推翻重写）；\n"
                  "3. 新内容与未修改的栏目设定一致、风格统一。\n"
                  "输出严格 JSON 对象（不要输出 JSON 以外的任何内容），只包含被选中栏目作为键。")
        res = self.call_llm([{"role": "system", "content": ASSIST_SYSTEM},
                             {"role": "user", "content": prompt}])
        obj = parse_json(res["content"])
        if obj is None:
            try:
                fix = ("你刚才的输出无法解析为合法 JSON。请重新输出：只输出一个合法的 JSON 对象，"
                       "只包含被选中栏目作为键，不要任何其他文字。")
                res2 = self.call_llm([{"role": "system", "content": ASSIST_SYSTEM},
                                      {"role": "user", "content": prompt},
                                      {"role": "assistant", "content": res["content"][-2000:]},
                                      {"role": "user", "content": fix}])
                obj = parse_json(res2["content"])
            except Exception:
                obj = None
        clean = {}
        if isinstance(obj, dict):
            for k in valid:
                v = obj.get(k)
                if v is not None and str(v).strip():
                    clean[k] = str(v)
        if not clean:
            raise llm.LLMError("AI 未能按意见修改，请换个说法再试")
        self.last_op = "ai_revise"
        self.last_assist = {"field": "ai_revise", "profile": clean, "fields": valid}

    def do_ai_discuss(self, text, draft):
        """世界观讨论：理解玩家简短想法，给出多个可选拓展方向。"""
        if not llm.api_ready(self.cfg):
            raise llm.LLMError("未配置 API：请在 config.json 的 api 里填写 api_key，然后重启本程序。")
        text = (text or "").strip()
        if not text:
            return
        draft = draft if isinstance(draft, dict) else {}
        self.last_op = "ai_assist"
        filled = {k: v for k, v in draft.items() if str(v or "").strip()}
        content = ("玩家已有的设定：\n" + json.dumps(filled, ensure_ascii=False) +
                   "\n玩家的新想法：" + text + "\n\n" + ASSIST_PROMPTS["discuss"])
        res = self.call_llm([{"role": "system", "content": ASSIST_SYSTEM},
                            {"role": "user", "content": content}])
        obj = parse_json(res["content"])
        if obj and isinstance(obj.get("options"), list) and obj["options"]:
            opts = [str(o).strip() for o in obj["options"] if str(o).strip()][:4]
            if opts:
                self.last_assist = {"field": "discuss",
                                    "summary": str(obj.get("summary", "") or "AI 这样理解你的想法："),
                                    "options": opts}
                return
        self.last_assist = {"field": "discuss",
                            "summary": "AI 这样理解你的想法：",
                            "options": [res["content"]]}

    # ---------- 设置 ----------

    def do_settings(self, show_reasoning):
        if show_reasoning is not None:
            self.cfg["show_reasoning"] = bool(show_reasoning)
            self.save_config()
        self.last_op = "settings"

    def do_free_mode(self):
        """一键切换到免费方案：优先智谱 GLM-4-Flash（永久免费，用已有的智谱密钥）。"""
        self.last_op = "free_mode"
        provs = dict(self.cfg.get("providers") or {})
        zp = dict(provs.get("zhipu") or {})
        if str(zp.get("api_key", "")).strip():
            zp["model"] = "glm-4-flash"
            zp["enabled"] = True
            provs["zhipu"] = zp
            self.cfg["providers"] = provs
            self.cfg["active_text"] = "zhipu"
            self.save_config()
            self.last_assist = {"field": "free_mode", "ok": True,
                                "msg": "已切换到 智谱 GLM-4-Flash（永久免费），立即生效，不再消耗 DeepSeek 余额"}
        else:
            self.last_assist = {
                "field": "free_mode", "ok": False,
                "msg": "未检测到智谱密钥。请到 open.bigmodel.cn 免费注册并创建 API Key，"
                       "填入下方「智谱GLM（GLM-4-Flash 永久免费）」卡片后保存，再点此按钮。"}

    def do_chunk_save(self, enabled, part_chars, max_parts, mode=None):
        """保存长文分段生成设置。"""
        c = dict(self.cfg.get("chunk") or CHUNK_DEFAULT)
        if enabled is not None:
            c["enabled"] = bool(enabled)
        if mode is not None and str(mode) in ("auto", "off", "on"):
            c["mode"] = str(mode)
        if part_chars is not None:
            try:
                v = int(part_chars)
                if 300 <= v <= 4000:
                    c["part_chars"] = v
            except (TypeError, ValueError):
                pass
        if max_parts is not None:
            try:
                v = int(max_parts)
                if 1 <= v <= 8:
                    c["max_parts"] = v
            except (TypeError, ValueError):
                pass
        self.cfg["chunk"] = c
        self.save_config()
        self.last_op = "chunk_save"

    # ---------- API 接口管理 ----------

    def save_config(self):
        try:
            with open(os.path.join(DATA_DIR, "config.json"), "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def do_providers_save(self, providers, active_text, active_image):
        if not isinstance(providers, dict) or not providers:
            raise llm.LLMError("没有可保存的厂商配置")
        clean = {}
        for pid, p in providers.items():
            if not isinstance(p, dict) or not str(p.get("name", "")).strip():
                continue
            c = {}
            for k in ("name", "base_url", "api_key", "model", "img_model", "img_api", "type"):
                c[k] = str(p.get(k, "") or "").strip()
            c["enabled"] = bool(p.get("enabled", True))
            clean[str(pid)] = c
        if not clean:
            raise llm.LLMError("没有可保存的厂商配置")
        self.cfg["providers"] = clean
        if active_text in clean:
            self.cfg["active_text"] = str(active_text)
        if active_image in clean:
            self.cfg["active_image"] = str(active_image)
        self.save_config()
        self.last_op = "providers_save"

    def do_list_models(self, provider):
        """拉取该密钥可用的模型列表（用于模型下拉选择）。"""
        self.last_op = "list_models"
        try:
            models = llm.list_models(self.cfg, provider if isinstance(provider, dict) else None)
            self.last_assist = {"field": "list_models", "ok": True, "models": models}
        except llm.LLMError as e:
            self.last_assist = {"field": "list_models", "ok": False, "error": str(e), "models": []}

    def do_test_api(self, provider):
        """测试 API 密钥与模型连接是否可用。"""
        self.last_op = "test_api"
        model = ""
        if isinstance(provider, dict):
            model = str(provider.get("model", "") or "")
        try:
            r = llm.test_chat(self.cfg, provider if isinstance(provider, dict) else None)
            self.last_assist = {"field": "test_api", "ok": True, "ms": r.get("ms", 0),
                                "reply": r.get("reply", ""),
                                "model": model or llm._text_cfg(self.cfg).get("model", "")}
        except llm.LLMError as e:
            self.last_assist = {"field": "test_api", "ok": False, "error": str(e), "model": model}

    def do_cultivation_preset(self):
        """返回修仙小说世界模板（一键创建用，较长文本高质量设定）。"""
        self.last_op = "cultivation_preset"
        self.last_assist = {"field": "cultivation_preset", "template": dict(XIANXIA_TEMPLATE)}

    def do_image_gen(self, prompt, use_context=True):
        prompt = (prompt or "").strip()
        final_prompt = prompt
        # 联系剧情生图：先把最近剧情提炼成画面描述
        if use_context and self.history:
            ctx = "\n".join(m["content"][:200] for m in self.history[-6:]
                            if m.get("content") and m["role"] in ("user", "assistant"))
            ctx = ctx.strip()
            if ctx:
                try:
                    msgs = [
                        {"role": "system", "content": "你是文生图提示词专家，擅长把小说剧情提炼成富有画面感的图像描述。"},
                        {"role": "user", "content":
                         "剧情片段：\n" + ctx +
                         ("\n玩家补充要求：" + prompt if prompt else "") +
                         "\n请输出一段适合文生图的中文画面描述（120 字以内），"
                         "包含场景、人物、氛围与画风建议，直接输出描述文字。"},
                    ]
                    res = self.call_llm(msgs)
                    if res.get("content"):
                        final_prompt = res["content"][:400]
                except Exception:
                    final_prompt = (prompt + " 剧情背景：" + ctx[:300]).strip() or prompt
        if not final_prompt:
            raise llm.LLMError("请描述想生成的画面，或先开始一段剧情")
        fname = llm.image_generate(final_prompt, self.cfg, os.path.join(DATA_DIR, "images"))
        # 图片作为对话的一部分写入记忆：更新/重启后依然显示在原位置
        self.history.append({"role": "image", "content": fname, "reasoning": ""})
        self.save_memory()
        self.last_op = "image_gen"
        self.last_assist = {"field": "image", "file": fname, "prompt": final_prompt}


# =========================================================
# HTTP 服务
# =========================================================

_CONTROLLER = None
_CONTROLLER_LOCK = threading.Lock()


def get_controller():
    """延迟创建控制器（桌面版可在首次请求前覆盖数据目录）。"""
    global _CONTROLLER
    with _CONTROLLER_LOCK:
        if _CONTROLLER is None:
            _CONTROLLER = Controller()
        return _CONTROLLER


class GameServer(ThreadingHTTPServer):
    """独占端口绑定的服务器：端口被占用时立即报错换端口，杜绝 Windows 双绑冲突。"""
    allow_reuse_address = False

    def server_bind(self):
        if sys.platform == "win32":
            try:
                import socket as _socket
                self.socket.setsockopt(_socket.SOL_SOCKET, _socket.SO_EXCLUSIVEADDRUSE, 1)
            except Exception:
                pass
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "WanXiang/2.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, bytes):
            data = body
        elif isinstance(body, str):
            data = body.encode("utf-8")
        else:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _serve_file(self, name, ctype):
        path = os.path.join(STATIC_DIR, name)
        if not os.path.exists(path):
            self._send(404, "Not Found", "text/plain; charset=utf-8")
            return
        with open(path, "r", encoding="utf-8") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
        elif path == "/style.css":
            self._serve_file("style.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self._serve_file("app.js", "application/javascript; charset=utf-8")
        elif path == "/manifest.json":
            self._serve_file("manifest.json", "application/manifest+json")
        elif path == "/sw.js":
            self._serve_file("sw.js", "application/javascript; charset=utf-8")
        elif path == "/icon512.png":
            full = os.path.join(STATIC_DIR, "icon512.png")
            if os.path.exists(full):
                try:
                    with open(full, "rb") as f:
                        self._send(200, f.read(), "image/png")
                except Exception:
                    self._send(404, "Not Found", "text/plain; charset=utf-8")
            else:
                self._send(404, "Not Found", "text/plain; charset=utf-8")
        elif path.startswith("/images/"):
            fname = os.path.basename(path)
            full = os.path.join(DATA_DIR, "images", fname)
            if os.path.exists(full):
                try:
                    with open(full, "rb") as f:
                        data = f.read()
                    ctype = "image/png" if fname.lower().endswith(".png") else "image/jpeg"
                    self._send(200, data, ctype)
                    return
                except Exception:
                    pass
            self._send(404, "Not Found", "text/plain; charset=utf-8")
        elif path == "/api/tts":
            local = (self.client_address[0] in ("127.0.0.1", "::1")) and (os.environ.get("WX_FORCE_CODE") != "1")
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            text = (q.get("text") or [""])[0]
            slot = (q.get("slot") or ["gentle"])[0]
            voice = (q.get("voice") or [""])[0]
            rate = (q.get("rate") or [""])[0]
            pitch = (q.get("pitch") or [""])[0]
            code = (q.get("code") or [""])[0]
            ctrl = get_controller()
            if (not local) and ctrl.access_code and code != ctrl.access_code:
                self._send(200, json.dumps({"error": "need_code"}, ensure_ascii=False).encode("utf-8"),
                           "application/json; charset=utf-8")
                return
            try:
                data = ctrl.tts_audio(text, slot, voice, rate, pitch)
                if not data:
                    self._send(404, "Not Found", "text/plain; charset=utf-8")
                    return
                self._send(200, data, "audio/mpeg")
            except llm.LLMError as e:
                self._send(200, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                           "application/json; charset=utf-8")
        else:
            self._send(404, "Not Found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/action":
            self._send(404, "Not Found", "text/plain; charset=utf-8")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            payload = {}
        local = (self.client_address[0] in ("127.0.0.1", "::1")) and (os.environ.get("WX_FORCE_CODE") != "1")
        code = self.headers.get("X-WX-Code") or ""
        self._send(200, get_controller().handle(payload, code, local))


def main():
    server = None
    for port in PORTS:
        try:
            server = GameServer((HOST, port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print("无法启动服务器：端口被占用。")
        time.sleep(3)
        sys.exit(1)
    server.daemon_threads = True
    url = f"http://{HOST}:{port}"
    print("═" * 46)
    print("  万 象 幻 境 · 全自由 AI 文字世界")
    print(f"  游戏地址：{url}")
    print("  浏览器未自动打开时，请手动访问上面的地址。")
    print("  关闭本窗口即退出游戏。所有进度自动保存。")
    print("═" * 46)
    if os.environ.get("WANXIANG_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已关闭。再见，道友。")


if __name__ == "__main__":
    main()
