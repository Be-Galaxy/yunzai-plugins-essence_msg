import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import puppeteer from 'puppeteer';
import { segment } from 'oicq';
import plugin from '../../lib/plugins/plugin.js';
import fetch from 'node-fetch';

// === 配置 ===
const cfg = {
  database: {
    type: 'mysql',  // mysql 或 sqlite
    mysql: {
      host: '1Panel-mysql-Wwag',
      port: 3306,
      user: 'msg-qq',
      password: process.env.DB_PASSWORD || '6NCpQ3sk6KCijx3S',
      database: 'msg-qq'
    },
    sqlite: {
      path: path.join(process.cwd(), './data/essence.db') //使用Mysql则此配置无效
    }
  },
  pagination: {pageSize: 5 }, //配置 #精华消息列表 的单页展示的精华消息条数

  tempDir: path.join(process.cwd(), './data/essence_temp'), // 临时文件目录
  imageSaveDir: path.join(process.cwd(), './data/essence_images'), // 本地图片存储目录
};

// 创建临时目录
!fs.existsSync(cfg.tempDir) && fs.mkdirSync(cfg.tempDir, { recursive: true });

// 确保图片存储目录存在
!fs.existsSync(cfg.imageSaveDir) && fs.mkdirSync(cfg.imageSaveDir, { recursive: true });

/**
 * 获取群成员名片或昵称（优先名片）
 */
function getMemberCardOrName(e, user_id, group_id) {
  // 先尝试 e.group.pickMember
  try {
    if (e.group && typeof e.group.pickMember === 'function') {
      const member = e.group.pickMember(user_id);
      if (member && (member.card || member.nickname)) {
        return member.card || member.nickname || String(user_id);
      }
    }
  } catch {}
  // 兼容 e.member
  if (e.member && e.member.user_id == user_id) {
    return e.member.card || e.member.nickname || String(user_id);
  }
  // 兼容 e.bot
  if (e.bot && typeof e.bot.pickMember === 'function') {
    try {
      const member = e.bot.pickMember(group_id, user_id);
      if (member && (member.card || member.nickname)) {
        return member.card || member.nickname || String(user_id);
      }
    } catch {}
  }
  return String(user_id);
}

/**
 * 获取群名
 */
function getGroupName(e, group_id) {
  if (e.group && (e.group.name || e.group.group_name)) {
    return e.group.name || e.group.group_name || String(group_id);
  }
  if (e.bot && typeof e.bot.pickGroup === 'function') {
    try {
      const group = e.bot.pickGroup(group_id);
      if (group && (group.name || group.group_name)) {
        return group.name || group.group_name || String(group_id);
      }
    } catch {}
  }
  return String(group_id);
}

/** Puppeteer 浏览器实例复用 **/
let browserInstance;
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new'
    });
  }
  return browserInstance;
}


/**
 * 从 CQ:image 中直接提取 url 下载图片到本地并返回本地路径
 */
async function getImageAndSaveToLocalFromUrl(url) {
  try {
    url = url.replace(/amp;/g, ''); // 去掉 amp;

    const ext = path.extname(url.split('?')[0]) || '.png';
    const fileName = `essence_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(cfg.imageSaveDir, fileName);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://multimedia.nt.qq.com.cn/'
      }
    });

    if (!res.ok) throw new Error(`图片下载失败，状态码：${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return destPath;
  } catch (err) {
    logger.error(`图片保存失败: ${url}，${err.message}`);
    throw new Error(`图片保存失败: ${url}，${err.message}`);
  }
}

/** 处理CQ码中的图片，提取 url 字段下载到本地 **/
async function handleCQImagesToLocal(content) {
  const imgCQ = /\[CQ:image.*?file=([^,\]]+).*?url=([^,\]]+).*?\]/g;
  let match;
  let images = [];
  let text = content;
  let idx = 0;

  while ((match = imgCQ.exec(content)) !== null) {
    const url = match[2];
    try {
      const localPath = await getImageAndSaveToLocalFromUrl(url);
      images.push(localPath);
      text = text.replace(match[0], `[[[essence_img_${idx}]]]`);
      idx++;
    } catch (err) {
      logger.error(`图片处理失败: ${url}，${err.message}`);
    }
  }

  return { text, images };
}





/** 数据库连接 **/
let dbConn;
async function connectDB() {
  if (dbConn) return dbConn;
  try {
    if (cfg.database.type === 'mysql') {
      dbConn = await mysql.createPool(cfg.database.mysql);
    } else {
      dbConn = await open({
        filename: cfg.database.sqlite.path,
        driver: sqlite3.Database
      });
    }
    const ddl = cfg.database.type === 'mysql' ? `
      CREATE TABLE IF NOT EXISTS essence_messages (
        message_id INT AUTO_INCREMENT PRIMARY KEY,
        group_id BIGINT NOT NULL,
        sender_id BIGINT NOT NULL,
        operator_id BIGINT NOT NULL,
        operator_time DATETIME NOT NULL,
        content TEXT NOT NULL,
        del_tag TINYINT(1) NOT NULL DEFAULT 0
      ) CHARSET=utf8mb4;` : `
      CREATE TABLE IF NOT EXISTS essence_messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        operator_id INTEGER NOT NULL,
        operator_time TEXT NOT NULL,
        content TEXT NOT NULL,
        del_tag INTEGER NOT NULL DEFAULT 0
      );`;
    await dbConn.query ? dbConn.query(ddl) : dbConn.exec(ddl);
    return dbConn;
  } catch (err) {
    logger.error(`数据库连接失败: ${err.stack}`);
    throw err;
  }
}

/** 初始化数据库操作 **/
async function initEssenceDB() {
  dbConn = null;
  await connectDB();
}

/** 数据库操作 **/
async function addEssence(gid, sid, oid, content, e) {
  const { text, images } = await handleCQImagesToLocal(content, content); // 处理图片和文本
  const jsonContent = JSON.stringify({ text, images }); // 转换为 JSON 字符串
  const conn = await connectDB();
  const now = new Date()
    .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    .replace(/\//g, '-')
    .replace(/\b(\d)\b/g, '0$1');

  try {
    const sql = `INSERT INTO essence_messages
      (group_id, sender_id, operator_id, operator_time, content) VALUES (?, ?, ?, ?, ?)`;
    const ps = [gid, sid, oid, now, jsonContent];
    const [result] = cfg.database.type === 'mysql'
      ? await conn.execute(sql, ps)
      : [await conn.run(sql, ps)];
    return result.insertId || result.lastID;
  } catch (err) {
    logger.error(`添加精华失败: ${err.stack}`);
    throw err;
  }
}

async function fetchEssenceList(gid, page = 1) {
  const conn = await connectDB();
  const limit = cfg.pagination.pageSize;
  const offset = (page - 1) * limit;

  try {
    const sql = cfg.database.type === 'mysql'
      ? `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY operator_time DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY operator_time DESC LIMIT ? OFFSET ?`;
    const ps = [gid, limit, offset];
    const [rows] = cfg.database.type === 'mysql'
      ? await conn.execute(sql, ps)
      : [await conn.all(sql, ps)];
    return rows;
  } catch (err) {
    logger.error(`生成精华消息列表失败: ${err.stack}`);
    throw err;
  }
}

async function fetchEssenceById(id) {
  const conn = await connectDB();
  try {
    const sql = `SELECT * FROM essence_messages WHERE message_id=? AND del_tag=0`;
    const [rows] = cfg.database.type === 'mysql'
      ? await conn.execute(sql, [id])
      : [await conn.all(sql, [id])];
    return rows[0] || null;
  } catch (err) {
    logger.error(`查询单个精华失败: ${err.stack}`);
    throw err;
  }
}

/** 分页查询 **/
async function fetchEssencePage(gid, page = 1, pageSize = cfg.pagination.pageSize) {
  const conn = await connectDB();
  const limit = Number(pageSize);
  const offset = (Number(page) - 1) * limit;
  try {
    let rows, total;
    if (cfg.database.type === 'mysql') {
      const [rowsRes] = await conn.execute(
        `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY message_id ASC LIMIT ${limit} OFFSET ${offset}`,
        [gid]
      );
      rows = rowsRes;
      const [[{ count }]] = await conn.query(
        'SELECT COUNT(*) as count FROM essence_messages WHERE group_id=? AND del_tag=0',
        [gid]
      );
      total = count;
    } else {
      const [rowsRes] = [await conn.all(
        `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY message_id ASC LIMIT ? OFFSET ?`,
        [gid, limit, offset]
      )];
      rows = rowsRes;
      const [{ count }] = await conn.all(
        'SELECT COUNT(*) as count FROM essence_messages WHERE group_id=? AND del_tag=0',
        [gid]
      );
      total = count;
    }
    return { rows, total };
  } catch (err) {
    logger.error(`分页查询精华失败: ${err.stack}`);
    throw err;
  }
}

// 删除逻辑：将 del_tag 置为 1（不再使用事务，兼容 mysql2 的 pool）
async function delEssence(id, gid) {
  const conn = await connectDB();
  try {
    const sql = `UPDATE essence_messages SET del_tag=1 WHERE message_id=? AND group_id=? AND del_tag=0`;
    const ps = [id, gid];
    if (cfg.database.type === 'mysql') {
      const [result] = await conn.execute(sql, ps);
      return result.affectedRows;
    } else {
      const result = await conn.run(sql, ps);
      return result.changes;
    }
  } catch (err) {
    logger.error(`删除精华失败: ${err.stack}`);
    throw err;
  }
}

/** HTML转义，防止XSS **/
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseEssenceContent(content) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    return escapeHtml(content);
  }
  let html = escapeHtml(obj.text || '');
  if (Array.isArray(obj.images)) {
    obj.images.forEach((img, idx) => {
      let base64 = '';
      try {
        const buffer = fs.readFileSync(img);
        const ext = path.extname(img).toLowerCase();
        let mime = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.gif') mime = 'image/gif';
        else if (ext === '.webp') mime = 'image/webp';
        base64 = `data:${mime};base64,${buffer.toString('base64')}`;
      } catch {
        base64 = '';
      }
      html = html.replace(
        `[[[essence_img_${idx}]]]`,
        base64
          ? `<img src="${base64}" style="max-width:100%;display:block;margin:5px 0">`
          : `<span style="color:red">[图片丢失]</span>`
      );
    });
  }
  return html;
}

/** 格式化时间为 YYYY年MM月DD日 HH:MM:SS 星期X，仅用于html显示 **/
function formatOperatorTime(datetimeStr) {
  if (!datetimeStr) return '';
  // 兼容 Date 类型和字符串类型
  let date;
  if (typeof datetimeStr === 'string') {
    date = new Date(datetimeStr.replace(/-/g, '/'));
  } else if (datetimeStr instanceof Date) {
    date = datetimeStr;
  } else {
    return String(datetimeStr ?? '');
  }
  if (isNaN(date.getTime())) return String(datetimeStr ?? '');
  const weekMap = ['日', '一', '二', '三', '四', '五', '六'];
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const week = weekMap[date.getDay()];
  return `${y}年${m}月${d}日 ${h}:${min}:${s} 星期${week}`;
}

/** HTML生成 **/
function buildHtml(type, items, page = 1, group_name = '' ) {
  let html = `
<html><head>
<meta charset="utf-8">
<style>
 body{font-family:'Microsoft YaHei',sans-serif;padding:20px;background:#f5f5f5;}
 .item{background:#fff;border-radius:8px;padding:15px;margin-bottom:15px;box-shadow:0 2px 4px rgba(0,0,0,0.1);}
 .hd{display:flex;align-items:center;margin-bottom:8px;}
 .hd img{width:40px;height:40px;border-radius:50%;margin-right:12px;}
 .meta{font-size:13px;color:#666;margin-bottom:5px;}
 .id{font-size:12px;color:#999;margin-top:5px;}
 .content{font-size:15px;color:#333;line-height:1.6;}
 .pagination{margin-top:20px;text-align:center;}
 .page-btn{padding:6px 12px;margin:0 4px;border-radius:4px;background:#007bff;color:#fff;border:none;cursor:pointer;}
 @media (max-width: 900px) {
   body {padding: 5vw;}
   .item {padding: 3vw;}
   .content {font-size: 4vw;}
 }
</style>
</head><body>
<h2 style="color:#333;border-bottom:2px solid #eee;padding-bottom:10px;">
  ${group_name ? `${group_name}（${items[0]?.group_id || ''}）` : (items[0]?.group_id || '')} 群精华消息 ${type === 'all' ? `- 第${page}页` : ''}
</h2>
`;
  items.forEach(m => {
    const content = parseEssenceContent(m.content);
    html += `
<div class="item">
  <div class="hd">
    <img src="https://q1.qlogo.cn/g?b=qq&nk=${m.sender_id}&s=100" />
    <div>
      <div style="font-weight:500;">${m.sender_card || ('用户 ' + m.sender_id)}</div>
      <div class="meta">
        添加人：${ m.operator_card || m.operator_id} | 添加时间：${formatOperatorTime(m.operator_time)}
      </div>
      <div class="id">精华消息 ID：${m.message_id}</div>
    </div>
  </div>
  <div class="content">${content}</div>
</div>`;
  });
  html += `</body></html>`;
  return html;
}

/** Yunzai 插件 **/
export class EssencePlugin extends plugin {
  constructor() {
    super({
      name: '群精华消息',
      dsc: '设置/查询/删除精华消息',
      event: 'message.group',
      priority: 1000,
      rule: [
        { reg: '^#(设精|设置精华消息)$', fnc: 'onSet' },
        { reg: '^#查询精华消息(?:\\s+(\\d+))?$', fnc: 'onQuery' },
        { reg: '^#(del精华|删除精华消息)\\s+(\\d+)$', fnc: 'onDel', permission: "master" },
        { reg: '^#(随机精华|随机群友怪话|随机精华消息)$', fnc: 'onRandom' },
        { reg: '^#精华消息列表(\\d+)?$', fnc: 'onPage' },
        { reg: '^#精华消息功能帮助$', fnc: 'onHelp' }
      ],
    });
  }

  async onStart() {
    try {
      await initEssenceDB();
      logger.info('精华插件已初始化');
      // 每天清理一次临时文件
      setInterval(() => {
        fs.readdir(cfg.tempDir, (err, files) => {
          files?.forEach(file => {
            const filePath = path.join(cfg.tempDir, file);
            const stat = fs.statSync(filePath);
            if (Date.now() - stat.ctimeMs > 86400000) {
              fs.unlinkSync(filePath);
            }
          });
        });
      }, 86400000);
    } catch (err) {
      logger.error(`插件启动失败: ${err.stack}`);
    }
  }

  /** 获取源消息 **/
  async getSourceMessage(e) {
    // 优先用 getReply
    if (typeof e.getReply === 'function') {
      const reply = await e.getReply();
      if (reply && reply.raw_message) return reply;
    }
    // 兼容 oicq v3+ 的 e.source
    if (e.source && e.source.seq) {
      try {
        const history = await e.group.getChatHistory(e.source.seq, 1);
        if (history && history.length) return history[0];
      } catch {}
    }
    // 兼容 e.message_chain 或 e.message
    if (Array.isArray(e.message_chain)) {
      const replyMsg = e.message_chain.find(m => m.type === 'reply' && m.id);
      if (replyMsg) {
        try {
          const history = await e.group.getChatHistory(replyMsg.id, 1);
          if (history && history.length) return history[0];
        } catch {}
      }
    }
    if (Array.isArray(e.message)) {
      const replyMsg = e.message.find(m => m.type === 'reply' && m.id);
      if (replyMsg) {
        try {
          const history = await e.group.getChatHistory(replyMsg.id, 1);
          if (history && history.length) return history[0];
        } catch {}
      }
    }
    return null;
  }

  /** 设置精华 **/
  async onSet(e) {
    try {
      const src = await this.getSourceMessage(e);
      if (!src?.raw_message) {
        return e.reply('❌ 请引用要设置为精华的消息后发送本命令', true);
      }
      const id = await addEssence(e.group_id, src.user_id, e.user_id, src.raw_message, e);
      return e.reply(`✅ 精华添加成功，ID：${id}`);
    } catch (err) {
      logger.error(`设置精华失败: ${err.stack}`);
      return e.reply('❌ 添加失败，请稍后重试');
    }
  }

  /** 查询精华 **/
  async onQuery(e) {
    try {
      const m = e.msg.match(/^#查询精华消息(?: (\d+))?$/);
      if (!m) {
        return e.reply('❌ 正确格式：#查询精华消息 <ID>', true);
      }
      const pageOrId = m[1] ? parseInt(m[1]) : null;

      if (!pageOrId) {
        return e.reply('❌ 正确格式：#查询精华消息 <ID>', true);
      }

      let items;

      if (pageOrId) {
        // 查询指定精华消息 ID
        const item = await fetchEssenceById(pageOrId);
        if (!item) return e.reply('❌ 未找到该精华消息');
        if (item.group_id !== e.group_id) {
          return e.reply('❌ 该消息不能在此群查询', true);
        }
        items = [item];
      } else {
        // 查询本群的精华消息（分页）
        items = await fetchEssenceList(e.group_id, pageOrId);
        if (!items.length) return e.reply('当前群暂无精华消息');
      }

      // 使用 Yunzai 接口获取 sender 和 operator 的 card/nickname
      for (const msg of items) {
        msg.sender_card = getMemberCardOrName(e, msg.sender_id, e.group_id);
        msg.operator_card = getMemberCardOrName(e, msg.operator_id, e.group_id);
      }

      // 获取群名
      let group_name = getGroupName(e, e.group_id);

      // 生成唯一文件名
      const filename = `essence-${Date.now()}-${e.group_id}.png`;
      const filepath = path.join(cfg.tempDir, filename);

      // 生成截图，动态调整高度以适配内容
      const browser = await getBrowser();
      const pageInst = await browser.newPage();
      await pageInst.setViewport({ width: 800, height: 3000 });
      await pageInst.setContent(buildHtml(m[1] ? 'single' : 'all', items, pageOrId, group_name), {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // 获取所有 .item 区块的高度和间距
      const totalHeight = await pageInst.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.item'));
        if (!items.length) return 800;
        let sum = 0;
        for (const el of items) {
          const style = window.getComputedStyle(el);
          sum += el.offsetHeight +
            parseFloat(style.marginTop || 0) +
            parseFloat(style.marginBottom || 0);
        }
        // 加上顶部标题和body padding
        const body = document.body;
        const bodyStyle = window.getComputedStyle(body);
        sum += body.offsetTop + parseFloat(bodyStyle.paddingTop || 0) + parseFloat(bodyStyle.paddingBottom || 0) + 120;
        return Math.max(sum, 400);
      });
      await pageInst.setViewport({ width: 800, height: Math.min(totalHeight, 10000) });
      await pageInst.screenshot({ path: filepath, fullPage: false });
      await pageInst.close();

      // 发送图片并删除本地文件
      await e.reply(segment.image(`file:///${filepath}`));
      fs.unlink(filepath, () => {});
      return;
    } catch (err) {
      logger.error(`查询精华失败: ${err.stack}`);
      return e.reply('❌ 查询失败，请稍后重试');
    }
  }

  /** 删除精华 **/
  async onDel(e) {
    try {
      const m = e.msg.match(/^#删除精华消息 (\d+)$/);
      if (!m) return e.reply('❌ 格式错误，正确格式：#删除精华消息 ID');
      
      const id = Number(m[1]);
      if (isNaN(id)) return e.reply('❌ ID必须为数字');
      
      const changes = await delEssence(id, e.group_id);
      return e.reply(changes > 0 ? '✅ 删除成功' : '❌ 删除失败，ID不存在或不属于本群');
    } catch (err) {
      logger.error(`删除精华失败: ${err.stack}`);
      return e.reply('❌ 删除失败，请检查日志');
    }
  }

  /** 随机获取一条精华消息 **/
  async onRandom(e) {
    try {
      const conn = await connectDB();
      const sql = cfg.database.type === 'mysql'
        ? `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY RAND() LIMIT 1`
        : `SELECT * FROM essence_messages WHERE group_id=? AND del_tag=0 ORDER BY RANDOM() LIMIT 1`;
      const [rows] = cfg.database.type === 'mysql'
        ? await conn.execute(sql, [e.group_id])
        : [await conn.all(sql, [e.group_id])];

      if (!rows.length) return e.reply('当前群暂无精华消息');

      const msg = rows[0];
      msg.sender_card = getMemberCardOrName(e, msg.sender_id, e.group_id);
      msg.operator_card = getMemberCardOrName(e, msg.operator_id, e.group_id);

      // 获取群名
      let group_name = getGroupName(e, e.group_id);

      const html = buildHtml('single', [msg], 1, group_name);

      const filename = `essence-random-${Date.now()}-${e.group_id}.png`;
      const filepath = path.join(cfg.tempDir, filename);

      const browser = await getBrowser();
      const pageInst = await browser.newPage();
      await pageInst.setViewport({ width: 800, height: 3000 });
      await pageInst.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

      // 动态获取 .item 区块高度
      const totalHeight = await pageInst.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.item'));
        if (!items.length) return 800;
        let sum = 0;
        for (const el of items) {
          const style = window.getComputedStyle(el);
          sum += el.offsetHeight +
            parseFloat(style.marginTop || 0) +
            parseFloat(style.marginBottom || 0);
        }
        const body = document.body;
        const bodyStyle = window.getComputedStyle(body);
        sum += body.offsetTop + parseFloat(bodyStyle.paddingTop || 0) + parseFloat(bodyStyle.paddingBottom || 0) + 120;
        return Math.max(sum, 400);
      });
      await pageInst.setViewport({ width: 800, height: Math.min(totalHeight, 10000) });
      await pageInst.screenshot({ path: filepath, fullPage: false });
      await pageInst.close();

      await e.reply(segment.image(`file:///${filepath}`));
      fs.unlink(filepath, () => {});
      return;
    } catch (err) {
      logger.error(`随机精华消息失败: ${err.stack}`);
      return e.reply('❌ 获取失败，请稍后重试');
    }
  }

  /** 分页查询精华消息 **/
  async onPage(e) {
    try {
      const m = e.msg.match(/^#精华消息列表(\d+)?$/);
      const page = m && m[1] ? parseInt(m[1]) : 1;
      if (page < 1) return e.reply('❌ 页码需为正整数');
      const { rows, total } = await fetchEssencePage(e.group_id, page);
      if (!rows.length) return e.reply('当前页暂无精华消息');
      for (const msg of rows) {
        msg.sender_card = getMemberCardOrName(e, msg.sender_id, e.group_id);
        msg.operator_card = getMemberCardOrName(e, msg.operator_id, e.group_id);
      }
      let group_name = getGroupName(e, e.group_id);
      const filename = `essence-page-${page}-${Date.now()}-${e.group_id}.png`;
      const filepath = path.join(cfg.tempDir, filename);
      const browser = await getBrowser();
      const pageInst = await browser.newPage();
      // 先设置一个较大高度，保证内容完整显示
      await pageInst.setViewport({ width: 800, height: 3000 });
      await pageInst.setContent(buildHtml('all', rows, page, group_name), {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // 动态获取 .item 区块高度
      const totalHeight = await pageInst.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.item'));
        if (!items.length) return 800;
        let sum = 0;
        for (const el of items) {
          const style = window.getComputedStyle(el);
          sum += el.offsetHeight +
            parseFloat(style.marginTop || 0) +
            parseFloat(style.marginBottom || 0);
        }
        const body = document.body;
        const bodyStyle = window.getComputedStyle(body);
        sum += body.offsetTop + parseFloat(bodyStyle.paddingTop || 0) + parseFloat(bodyStyle.paddingBottom || 0) + 120;
        return Math.max(sum, 400);
      });
      await pageInst.setViewport({ width: 800, height: Math.min(totalHeight, 10000) });
      await pageInst.screenshot({ path: filepath, fullPage: false });
      await pageInst.close();
      const totalPage = Math.ceil(total / cfg.pagination.pageSize);
      let tip = `第 ${page} / ${totalPage} 页，共 ${total} 条精华消息`;
      await e.reply([segment.image(`file:///${filepath}`), tip]);
      fs.unlink(filepath, () => {});
      return;
    } catch (err) {
      logger.error(`分页查询精华失败: ${err.stack}`);
      return e.reply('❌ 查询失败，请稍后重试');
    }
  }

  /** 帮助列表 **/
  async onHelp(e) {
    const msg = [
      '【群精华消息插件 帮助】',
      '------------------------',
      '1. #设精 或 #设置精华消息（需引用消息）',
      '   - 将引用的消息设为精华',
      '2. #查询精华消息 <ID>',
      '   - 查询指定ID的精华消息',
      '3. #精华消息列表 或 #精华消息列表<页码>',
      '   - 分页查看本群精华消息',
      '4. #随机精华 / #随机群友怪话 / #随机精华消息',
      '   - 随机展示一条本群精华消息',
      '5. #删除精华消息 <ID>（仅Bot主人）',
      '   - 删除指定ID的精华消息',
      '6. #精华消息功能帮助',
      '   - 查看本帮助',
      '------------------------'
    ].join('\n');
    return e.reply(msg);
  }
}
