import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATABASE_DIR = path.join(process.cwd(), "data");
const DATABASE_FILE = path.join(DATABASE_DIR, "database.json");

// Types for DB
interface DBData {
  settings: {
    adminIds: string[];
    summerRate: number;
    summerOvertimeRate: number;
    winterRate: number;
    winterOvertimeRate: number;
    botToken: string;
  };
  employees: Array<{
    id: string;
    name: string;
    telegramId: string | null;
    telegramUsername: string | null;
    startTime: string;
    endTime: string;
    startTime2?: string | null;
    endTime2?: string | null;
    createdAt: number;
  }>;
  attendance: Array<{
    id: string;
    employeeId: string;
    name: string;
    date: string;
    checkIn: number | null;
    checkOut: number | null;
    checkInVideoId: string | null;
    checkOutVideoId: string | null;
    workedMinutes: number;
    latenessMinutes: number;
    penaltyAmount: number;
    baseSalary: number;
    overtimeSalary: number;
    finalSalary: number;
    isCompleted: boolean;
    notes?: string;
  }>;
}

// In-Memory Database Cache (Write-Through)
let dbInMemoryCache: DBData | null = null;

// Initialize Postgres Client Pool if connection URL is set
let pool: pg.Pool | null = null;
const dbUrl = process.env.DATABASE_URL;

if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false } // Required for external cloud hosts (e.g. Render, Neon, Supabase)
  });
  console.log("PostgreSQL Target Database Configuration detected.");
}

function getDefaultData(): DBData {
  const defaultData: DBData = {
    settings: {
      adminIds: ["5624377303", "5523761749"],
      summerRate: 6500,
      summerOvertimeRate: 7000,
      winterRate: 6500,
      winterOvertimeRate: 7000,
      botToken: process.env.TELEGRAM_BOT_TOKEN || ""
    },
    employees: [
      {
        id: "123456",
        name: "Aliyev Vali",
        telegramId: "123456",
        telegramUsername: "valijon_a",
        startTime: "09:00",
        endTime: "18:00",
        createdAt: Date.now() - 10 * 24 * 3600 * 1000
      },
      {
        id: "789012",
        name: "Karimov Anvar",
        telegramId: "789012",
        telegramUsername: "anvar_k",
        startTime: "08:30",
        endTime: "17:30",
        createdAt: Date.now() - 9 * 24 * 3600 * 1000
      },
      {
        id: "345678",
        name: "Sharipova Dilnoza",
        telegramId: "345678",
        telegramUsername: "dilnoza_sh",
        startTime: "09:00",
        endTime: "18:00",
        createdAt: Date.now() - 5 * 24 * 3600 * 1000
      }
    ],
    attendance: [] as any[]
  };

  const today = new Date();
  for (let i = 1; i <= 5; i++) {
    const historicalDate = new Date();
    historicalDate.setDate(today.getDate() - i);
    if (historicalDate.getDay() === 0) continue; // Skip Sanday

    const dateStr = historicalDate.toISOString().split("T")[0];

    defaultData.attendance.push({
      id: `123456_${dateStr}`,
      employeeId: "123456",
      name: "Aliyev Vali",
      date: dateStr,
      checkIn: Math.floor(historicalDate.setHours(9, 5, 0, 0) / 1000), 
      checkOut: Math.floor(historicalDate.setHours(18, 15, 0, 0) / 1000), 
      checkInVideoId: "file_mock_in_1",
      checkOutVideoId: "file_mock_out_1",
      workedMinutes: 550, 
      latenessMinutes: 5,
      penaltyAmount: 0, 
      baseSalary: 6500 * (540 / 60), 
      overtimeSalary: 7000 * (10 / 60),
      finalSalary: (6500 * 9) + (7000 * (10 / 60)),
      isCompleted: true
    });

    defaultData.attendance.push({
      id: `789012_${dateStr}`,
      employeeId: "789012",
      name: "Karimov Anvar",
      date: dateStr,
      checkIn: Math.floor(historicalDate.setHours(8, 45, 0, 0) / 1000), 
      checkOut: Math.floor(historicalDate.setHours(17, 30, 0, 0) / 1000), 
      checkInVideoId: "file_mock_in_2",
      checkOutVideoId: "file_mock_out_2",
      workedMinutes: 525,
      latenessMinutes: 15,
      penaltyAmount: 15000, 
      baseSalary: 6500 * (525 / 60),
      overtimeSalary: 0,
      finalSalary: 6500 * (525 / 60) - 15000,
      isCompleted: true
    });
  }
  return defaultData;
}

function ensureAdminIds(data: DBData) {
  if (!data.settings) {
    data.settings = {
      adminIds: ["5624377303", "5523761749"],
      summerRate: 6500,
      summerOvertimeRate: 7000,
      winterRate: 6500,
      winterOvertimeRate: 7000,
      botToken: ""
    };
  }
  if (!data.settings.adminIds) {
    data.settings.adminIds = ["5624377303", "5523761749"];
  } else {
    if (!data.settings.adminIds.includes("5624377303")) {
      data.settings.adminIds.push("5624377303");
    }
    if (!data.settings.adminIds.includes("5523761749")) {
      data.settings.adminIds.push("5523761749");
    }
  }
}

// PostgreSQL Schemas Manager & Sync Operations
async function initDatabaseSchema() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    console.log("Checking and executing schemas in cloud PostgreSQL DB...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS sys_settings (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        telegram_id VARCHAR(50),
        telegram_username VARCHAR(255),
        start_time VARCHAR(10) NOT NULL,
        end_time VARCHAR(10) NOT NULL,
        start_time2 VARCHAR(10),
        end_time2 VARCHAR(10),
        created_at BIGINT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id VARCHAR(100) PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        date VARCHAR(20) NOT NULL,
        check_in BIGINT,
        check_out BIGINT,
        check_in_video_id VARCHAR(255),
        check_out_video_id VARCHAR(255),
        worked_minutes INT NOT NULL,
        lateness_minutes INT NOT NULL,
        penalty_amount INT NOT NULL,
        base_salary INT NOT NULL,
        overtime_salary INT NOT NULL,
        final_salary INT NOT NULL,
        is_completed BOOLEAN NOT NULL
      );
    `);
    console.log("Database tables initialized successfully!");
  } catch (err) {
    console.error("Failed to execute database schema migrations:", err);
  } finally {
    client.release();
  }
}

async function saveToPostgres(data: DBData) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Settings Table
    await client.query(
      `INSERT INTO sys_settings (id, data) VALUES ('config', $1)
       ON CONFLICT (id) DO UPDATE SET data = $1`,
      [JSON.stringify(data.settings)]
    );

    // 2. Refresh employees table
    await client.query("DELETE FROM employees");
    for (const emp of data.employees) {
      await client.query(
        `INSERT INTO employees (id, name, telegram_id, telegram_username, start_time, end_time, start_time2, end_time2, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [emp.id, emp.name, emp.telegramId, emp.telegramUsername, emp.startTime, emp.endTime, emp.startTime2 || null, emp.endTime2 || null, emp.createdAt]
      );
    }

    // 3. Refresh attendance table
    await client.query("DELETE FROM attendance");
    for (const att of data.attendance) {
      await client.query(
        `INSERT INTO attendance (id, employee_id, name, date, check_in, check_out, check_in_video_id, check_out_video_id, worked_minutes, lateness_minutes, penalty_amount, base_salary, overtime_salary, final_salary, is_completed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          att.id,
          att.employeeId,
          att.name,
          att.date,
          att.checkIn,
          att.checkOut,
          att.checkInVideoId,
          att.checkOutVideoId,
          att.workedMinutes,
          att.latenessMinutes,
          att.penaltyAmount,
          att.baseSalary,
          att.overtimeSalary,
          att.finalSalary,
          att.isCompleted
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function loadFromPostgres(): Promise<DBData | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const settingsRes = await client.query("SELECT data FROM sys_settings WHERE id = 'config'");
    const employeesRes = await client.query("SELECT * FROM employees");
    const attendanceRes = await client.query("SELECT * FROM attendance");

    if (settingsRes.rows.length === 0 && employeesRes.rows.length === 0) {
      // Database has been provisioned but has no entries yet
      return null;
    }

    const loadedSettings = settingsRes.rows[0]?.data || {
      adminIds: ["5624377303", "5523761749"],
      summerRate: 6500,
      summerOvertimeRate: 7000,
      winterRate: 6500,
      winterOvertimeRate: 7000,
      botToken: ""
    };

    const loadedEmployees = employeesRes.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      telegramId: row.telegram_id,
      telegramUsername: row.telegram_username,
      startTime: row.start_time,
      endTime: row.end_time,
      startTime2: row.start_time2 || null,
      endTime2: row.end_time2 || null,
      createdAt: Number(row.created_at)
    }));

    const loadedAttendance = attendanceRes.rows.map((row: any) => ({
      id: row.id,
      employeeId: row.employee_id,
      name: row.name,
      date: row.date,
      checkIn: row.check_in ? Number(row.check_in) : null,
      checkOut: row.check_out ? Number(row.check_out) : null,
      checkInVideoId: row.check_in_video_id,
      checkOutVideoId: row.check_out_video_id,
      workedMinutes: Number(row.worked_minutes),
      lateness_minutes: Number(row.lateness_minutes), // Handle lower case alias if keys changed
      latenessMinutes: row.lateness_minutes !== undefined ? Number(row.lateness_minutes) : Number(row.lateness_minutes || 0),
      penaltyAmount: Number(row.penalty_amount),
      baseSalary: Number(row.base_salary),
      overtimeSalary: Number(row.overtime_salary),
      finalSalary: Number(row.final_salary),
      isCompleted: Boolean(row.is_completed)
    }));

    return {
      settings: loadedSettings,
      employees: loadedEmployees,
      attendance: loadedAttendance
    };
  } catch (err) {
    console.error("An error occurred loading historical backup structures from PG:", err);
    return null;
  } finally {
    client.release();
  }
}

// Memory, Local disk, Postgres read & write bridges
function readDB(): DBData {
  if (dbInMemoryCache) {
    ensureAdminIds(dbInMemoryCache);
    return dbInMemoryCache;
  }

  // Ensure directories exist
  if (!fs.existsSync(DATABASE_DIR)) {
    fs.mkdirSync(DATABASE_DIR, { recursive: true });
  }

  try {
    if (fs.existsSync(DATABASE_FILE)) {
      const data = fs.readFileSync(DATABASE_FILE, "utf8");
      dbInMemoryCache = JSON.parse(data) as DBData;
    }
  } catch (err) {
    console.error("Could not sync read local database fallback layer. Utilizing recovery snapshot.", err);
  }

  if (!dbInMemoryCache) {
    dbInMemoryCache = getDefaultData();
  }

  ensureAdminIds(dbInMemoryCache);
  return dbInMemoryCache;
}

function writeDB(data: DBData) {
  ensureAdminIds(data);
  dbInMemoryCache = data;

  // 1. Save synchronously to local database fallback
  try {
    if (!fs.existsSync(DATABASE_DIR)) {
      fs.mkdirSync(DATABASE_DIR, { recursive: true });
    }
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing fallback database.json configuration.", err);
  }

  // 2. Sync to Postgres asynchronously if configured
  if (pool) {
    saveToPostgres(data).then(() => {
      console.log("Database transaction successfully synced to Cloud PostgreSQL.");
    }).catch((err) => {
      console.error("Failed to asynchronously batch synchronized save database records to cloud:", err);
    });
  }
}

// Timezone Conversions (Asia/Tashkent UTC+5)
function getTashkentDateParts(unixSeconds: number) {
  const date = new Date(unixSeconds * 1000);
  // Get components in Asia/Tashkent
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  
  const formattedParts = formatter.formatToParts(date);
  const findPart = (type: string) => formattedParts.find((p) => p.type === type)?.value || "00";
  
  const year = findPart("year");
  const month = findPart("month");
  const day = findPart("day");
  const hour = findPart("hour");
  const minute = findPart("minute");
  const second = findPart("second");
  
  return {
    dateStr: `${year}-${month}-${day}`, // YYYY-MM-DD
    timeStr: `${hour}:${minute}`,       // HH:MM
    hour: parseInt(hour, 10),
    minute: parseInt(minute, 10),
    monthIndex: parseInt(month, 10) - 1 // 0-based month index (0 = Jan, 3 = Apr, 9 = Oct)
  };
}

function timeStringToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Telegram Bot Administration & Setup
let bot: Telegraf | null = null;
let botError: string | null = null;
let botStatus: "inactive" | "active" | "error" = "inactive";

function initializeBot() {
  const dbData = readDB();
  const token = dbData.settings.botToken || process.env.TELEGRAM_BOT_TOKEN;

  if (bot) {
    try {
      bot.stop("restarting");
    } catch (e) {}
    bot = null;
  }

  if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN") {
    botError = "Telegram Bot Tokeni belgilanmagan. Sozlamalar sahifasidan kiritishingiz mumkin.";
    botStatus = "inactive";
    console.log("Telegram Bot skipped: No Token provided.");
    return;
  }

  try {
    bot = new Telegraf(token);
    botStatus = "active";
    botError = null;

    // Inline Menu Builders for Admins
    const getAdminMenuKeyboard = () => {
      return {
        inline_keyboard: [
          [
            { text: "📊 Bugungi Davomat Hisoboti", callback_data: "admin_report" },
            { text: "📈 Oylik Statistika", callback_data: "admin_stats" }
          ],
          [
            { text: "👤 Xodimlar Ro'yxati & Boshqaruv", callback_data: "admin_employees_list" }
          ],
          [
            { text: "➕ Xodim Qo'shish", callback_data: "admin_add_guide" },
            { text: "🧼 Jarimalarni Tozalash", callback_data: "admin_clear_guide" }
          ],
          [
            { text: "🔄 Menuni Yangilash", callback_data: "admin_refresh_menu" }
          ]
        ]
      };
    };

    const sendAdminMenu = (ctx: any, edit: boolean = false) => {
      const text = `👋 <b>Assalomu alaykum, hurmatli Administrator!</b>\n\n` +
                   `Sizning admin hisobingiz aniqlandi. Quyidagi boshqaruv paneli orqali xodimlar ro'yxatini ko'rish, hisobotlarni olish yoki jarimalarni bekor qilish ishlarini mutlaqo inline (klaviaturadan foydalanmagan holda) bajarishingiz mumkin.\n\n` +
                   `👇 Boshqarish uchun tugmani bosing:`;

      const extra = {
        parse_mode: "HTML" as const,
        reply_markup: getAdminMenuKeyboard()
      };

      if (edit) {
        return ctx.editMessageText(text, extra).catch(() => {});
      } else {
        return ctx.reply(text, extra);
      }
    };

    const renderEmployeeList = (ctx: any) => {
      const db = readDB();
      let empMsg = `👤 <b>Ro'yxatdagi Xodimlar:</b>\n\n` +
                   `<i>Barcha kiritilgan xodimlar ro'yxati va ularga tegishli tezkor buyruqlar:</i>\n\n`;
      const keyboard: any[] = [];

      if (db.employees.length === 0) {
        empMsg += `<i>Tizimda xodimlar mavjud emas. Web-dashboard yoki /add buyrug'i orqali yangi xodim kiriting.</i>`;
      } else {
        db.employees.forEach((emp) => {
          empMsg += `• 👤 <b>${emp.name}</b>\n   ID: <code>${emp.id}</code> | Rejim: ${emp.startTime} - ${emp.endTime}${emp.startTime2 && emp.endTime2 ? ` / ${emp.startTime2} - ${emp.endTime2}` : ''}\n\n`;
          keyboard.push([
            { text: `🧼 ${emp.name.split(" ")[0]} Jarima 0`, callback_data: `clear_p_${emp.id}` },
            { text: `❌ O'chirish`, callback_data: `del_e_${emp.id}` }
          ]);
        });
      }

      keyboard.push([{ text: "🔙 Orqaga", callback_data: "admin_menu" }]);

      return ctx.editMessageText(empMsg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: keyboard
        }
      }).catch(() => {});
    };

    // Command: /start
    bot.start((ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      const isAdmin = db.settings.adminIds.includes(fromId);
      const employee = db.employees.find((e) => e.telegramId === fromId || e.telegramUsername === ctx.from.username);

      if (isAdmin) {
        // Automatically open the inline menu for the admin on start!
        return sendAdminMenu(ctx, false);
      } else if (employee) {
        // Upgrade telegramId to current if it was only username
        if (!employee.telegramId) {
          employee.telegramId = fromId;
          writeDB(db);
        }

        const empRecords = db.attendance.filter((att) => att.employeeId === employee.id);
        const totalDays = empRecords.length;
        const totalWorkedMin = empRecords.reduce((sum, att) => sum + (att.workedMinutes || 0), 0);
        const totalLateMin = empRecords.reduce((sum, att) => sum + (att.latenessMinutes || 0), 0);
        const totalPenalty = empRecords.reduce((sum, att) => sum + (att.penaltyAmount || 0), 0);
        const totalSalaryEarned = empRecords.reduce((sum, att) => sum + (att.finalSalary || 0), 0);

        const hours = Math.floor(totalWorkedMin / 60);
        const mins = totalWorkedMin % 60;

        const { dateStr } = getTashkentDateParts(Math.floor(Date.now() / 1000));
        const todayRecord = empRecords.find((r) => r.date === dateStr);
        let todayStatus = "⚪ Bugun hali davomat yozilmagan";
        if (todayRecord) {
          const checkInStr = todayRecord.checkIn ? getTashkentDateParts(todayRecord.checkIn).timeStr : "kelmagan";
          const checkOutStr = todayRecord.checkOut ? getTashkentDateParts(todayRecord.checkOut).timeStr : "ketmagan";
          todayStatus = `📥 Keldi: <b>${checkInStr}</b> | 📤 Ketdi: <b>${checkOutStr}</b>`;
          if (todayRecord.latenessMinutes > 0) {
            todayStatus += `\n⚠️ Kechikish: <b>${todayRecord.latenessMinutes} daqiqa</b>`;
          }
        }

        const resp = `👋 Xush kelibsiz, <b>${employee.name}</b>!\n\n` +
                     `⚙️ Ish rejimingiz: <b>${employee.startTime} - ${employee.endTime}${employee.startTime2 && employee.endTime2 ? ` / ${employee.startTime2} - ${employee.endTime2}` : ''}</b>.\n\n` +
                     `📊 <b>Sizning Shaxsiy Statistikangiz:</b>\n` +
                     `• 📅 Jami ishlangan kunlar: <b>${totalDays} kun</b>\n` +
                     `• ⏰ Jami ishlangan vaqt: <b>${hours} soat, ${mins} daqiqa</b>\n` +
                     `• ⏱️ Jami kechikishlar: <b>${totalLateMin} daqiqa</b>\n` +
                     `• 💸 Jami hisoblangan jarimalar: <b>${totalPenalty.toLocaleString()} so'm</b>\n` +
                     `• 💵 Jami hisoblangan oylik maosh: <b>${totalSalaryEarned.toLocaleString()} so'm</b>\n\n` +
                     `📅 <b>Bugungi holatingiz (${dateStr}):</b>\n` +
                     `${todayStatus}\n\n` +
                     `📌 Davomat qoidalari:\n` +
                     `1. Kelganda botga <b>yumaloq video</b> yuboring.\n` +
                     `2. Ketganda yana bitta <b>yumaloq video</b> yuboring.\n\n` +
                     `Kuningiz xayrli va barakali o'tsin!`;

        return ctx.replyWithHTML(resp, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Yangilash", callback_data: `emp_refresh_${employee.id}` }
              ]
            ]
          }
        });
      } else {
        const resp = `👋 Assalomu alaykum!\n\n` +
                     `Siz hali Davomat Plus tizimida ro'yxatdan o'tmagansiz.\n` +
                     `🆔 Sizning Telegram ID: <code>${fromId}</code>\n` +
                     `Foydalanuvchi nomi: @${ctx.from.username || "yo'q"}\n\n` +
                     `Botda davomat berish va oyliklarni hisoblatish uchun ushbu IDni adminingizga yuboring.`;
        return ctx.replyWithHTML(resp);
      }
    });

    // Command: /menu (to allow easy access back to the inline dashboard for admin)
    bot.command("menu", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (db.settings.adminIds.includes(fromId)) {
        return sendAdminMenu(ctx, false);
      } else {
        return ctx.reply("❌ Ushbu buyruq faqat loyiha adminlari uchun mo'ljallangan.");
      }
    });

    // Setup Bot Action Callback Query Listener
    bot.on("callback_query", (ctx) => {
      const fromId = String(ctx.from?.id);
      const db = readDB();
      const cbQuery = ctx.callbackQuery as any;
      const data = cbQuery?.data || "";

      // Allow employees to refresh their own statistics screen
      if (data.startsWith("emp_refresh_")) {
        ctx.answerCbQuery("📊 Statistikangiz yangilandi!").catch(() => {});
        const empId = data.replace("emp_refresh_", "");
        const employee = db.employees.find((e) => e.id === empId);
        if (!employee) {
          return ctx.reply("Xodim topilmadi.").catch(() => {});
        }

        const empRecords = db.attendance.filter((att) => att.employeeId === employee.id);
        const totalDays = empRecords.length;
        const totalWorkedMin = empRecords.reduce((sum, att) => sum + (att.workedMinutes || 0), 0);
        const totalLateMin = empRecords.reduce((sum, att) => sum + (att.latenessMinutes || 0), 0);
        const totalPenalty = empRecords.reduce((sum, att) => sum + (att.penaltyAmount || 0), 0);
        const totalSalaryEarned = empRecords.reduce((sum, att) => sum + (att.finalSalary || 0), 0);

        const hours = Math.floor(totalWorkedMin / 60);
        const mins = totalWorkedMin % 60;

        const { dateStr } = getTashkentDateParts(Math.floor(Date.now() / 1000));
        const todayRecord = empRecords.find((r) => r.date === dateStr);
        let todayStatus = "⚪ Bugun hali davomat yozilmagan";
        if (todayRecord) {
          const checkInStr = todayRecord.checkIn ? getTashkentDateParts(todayRecord.checkIn).timeStr : "kelmagan";
          const checkOutStr = todayRecord.checkOut ? getTashkentDateParts(todayRecord.checkOut).timeStr : "ketmagan";
          todayStatus = `📥 Keldi: <b>${checkInStr}</b> | 📤 Ketdi: <b>${checkOutStr}</b>`;
          if (todayRecord.latenessMinutes > 0) {
            todayStatus += `\n⚠️ Kechikish: <b>${todayRecord.latenessMinutes} daqiqa</b>`;
          }
        }

        const resp = `👋 Xush kelibsiz, <b>${employee.name}</b>!\n\n` +
                     `⚙️ Ish rejimingiz: <b>${employee.startTime} - ${employee.endTime}${employee.startTime2 && employee.endTime2 ? ` / ${employee.startTime2} - ${employee.endTime2}` : ''}</b>.\n\n` +
                     `📊 <b>Sizning Shaxsiy Statistikangiz:</b>\n` +
                     `• 📅 Jami ishlangan kunlar: <b>${totalDays} kun</b>\n` +
                     `• ⏰ Jami ishlangan vaqt: <b>${hours} soat, ${mins} daqiqa</b>\n` +
                     `• ⏱️ Jami kechikishlar: <b>${totalLateMin} daqiqa</b>\n` +
                     `• 💸 Jami hisoblangan jarimalar: <b>${totalPenalty.toLocaleString()} so'm</b>\n` +
                     `• 💵 Jami hisoblangan oylik maosh: <b>${totalSalaryEarned.toLocaleString()} so'm</b>\n\n` +
                     `📅 <b>Bugungi holatingiz (${dateStr}):</b>\n` +
                     `${todayStatus}\n\n` +
                     `📌 Davomat qoidalari:\n` +
                     `1. Kelganda botga <b>yumaloq video</b> yuboring.\n` +
                     `2. Ketganda yana bitta <b>yumaloq video</b> yuboring.\n\n` +
                     `Kuningiz xayrli va barakali o'tsin!`;

        return ctx.editMessageText(resp, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Yangilash", callback_data: `emp_refresh_${employee.id}` }
              ]
            ]
          }
        }).catch(() => {});
      }

      // Rest of the callbacks are for admins only
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.answerCbQuery("🚷 Siz admin emassiz!").catch(() => {});
      }

      if (data === "admin_menu") {
        ctx.answerCbQuery().catch(() => {});
        return sendAdminMenu(ctx, true);
      } else if (data === "admin_refresh_menu") {
        ctx.answerCbQuery("🔄 Menu yangilandi").catch(() => {});
        return sendAdminMenu(ctx, true);
      } else if (data === "admin_report") {
        ctx.answerCbQuery("📊 Kunlik Hisobot...").catch(() => {});
        const messageEpoch = cbQuery?.message?.date || Math.floor(Date.now() / 1000);
        const { dateStr } = getTashkentDateParts(messageEpoch);
        const todayRecords = db.attendance.filter((att) => att.date === dateStr);

        let reportMsg = `📅 <b>Sana:</b> ${dateStr}\n` +
                        `👥 <b>Bugungi davomat hisoboti:</b>\n\n`;

        if (todayRecords.length === 0) {
          reportMsg += `<i>Bugun hali hech qanday xodim davomat yozuvi qayd etmadi.</i>`;
        } else {
          todayRecords.forEach((att) => {
            const checkInTime = att.checkIn ? getTashkentDateParts(att.checkIn).timeStr : "kelmagan";
            const checkOutTime = att.checkOut ? getTashkentDateParts(att.checkOut).timeStr : "ketmagan";
            const workedStr = att.workedMinutes > 0 ? `${Math.floor(att.workedMinutes / 60)}s ${att.workedMinutes % 60}m` : "-";
            const lateStr = att.latenessMinutes > 0 ? `⚠️ ${att.latenessMinutes} min` : "yo'q";
            const penaltyStr = att.penaltyAmount > 0 ? `${att.penaltyAmount.toLocaleString()} so'm` : "yo'q";

            reportMsg += `👤 <b>${att.name}</b>\n` +
                         `📥 Keldi: ${checkInTime}\n` +
                         `📤 Ketdi: ${checkOutTime}\n` +
                         `⏰ Ishladi: ${workedStr}\n` +
                         `⏱️ Kechikish: ${lateStr}\n` +
                         `💸 Jarima: ${penaltyStr}\n` +
                         `💵 To'lov: ${att.finalSalary.toLocaleString()} so'm\n` +
                         `---------------------------\n`;
          });
        }

        return ctx.editMessageText(reportMsg, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Yangilash", callback_data: "admin_report" },
                { text: "🔙 Orqaga", callback_data: "admin_menu" }
              ]
            ]
          }
        }).catch(() => {});
      } else if (data === "admin_stats") {
        ctx.answerCbQuery("📈 Oylik Statistika...").catch(() => {});
        const totalEmp = db.employees.length;
        const totalPenalties = db.attendance.reduce((sum, item) => sum + (item.penaltyAmount || 0), 0);
        const totalWages = db.attendance.reduce((sum, item) => sum + (item.finalSalary || 0), 0);

        const statsMsg = `📊 <b>Tizimning umumiy moliya statistikasi:</b>\n\n` +
                         `👥 Jami xodimlar soni: <b>${totalEmp} ta</b>\n` +
                         `💸 Jami jarimalar summasi: <b>${totalPenalties.toLocaleString()} so'm</b>\n` +
                         `💵 Jami hisoblangan ish haqi: <b>${totalWages.toLocaleString()} so'm</b>\n\n` +
                         `<i>Batafsil ma'lumotlar, chizma diagrammalar va yangilash ishlari uchun Web Dashboard'ga kiring.</i>`;

        return ctx.editMessageText(statsMsg, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔙 Orqaga", callback_data: "admin_menu" }
              ]
            ]
          }
        }).catch(() => {});
      } else if (data === "admin_employees_list") {
        ctx.answerCbQuery().catch(() => {});
        return renderEmployeeList(ctx);
      } else if (data === "admin_add_guide") {
        ctx.answerCbQuery().catch(() => {});
        const text = `➕ <b>Yangi Xodim Qo'shish Yo'riqnomasi:</b>\n\n` +
                     `Xodimni bot orqali qo'shish uchun quyidagi matn formatida botga xabar yuboring:\n` +
                     `<code>/add &lt;telegram_id&gt; &lt;Ism Familiya&gt; &lt;boshlash1&gt; &lt;tugash1&gt; [boshlash2] [tugash2]</code>\n\n` +
                     `💬 <b>Misol (1 navbat):</b>\n` +
                     `<code>/add 5624377303 Ergashev Sherzod 08:30 18:00</code>\n\n` +
                     `💬 <b>Misol (2 navbat):</b>\n` +
                     `<code>/add 5624377303 Xoshimov Abdurasul 8:00 15:00 22:00 2:00</code>\n\n` +
                     `<i>Eslatma: ID xodimning Telegram ID raqami bo'lishi shart. Uni olish uchun xodimizga botni boshlatib bering, u yerda uning ID-si ko'rinadi.</i>`;

        return ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔙 Orqaga", callback_data: "admin_menu" }
              ]
            ]
          }
        }).catch(() => {});
      } else if (data === "admin_clear_guide") {
        ctx.answerCbQuery().catch(() => {});
        const text = `🧼 <b>Jarimalarni Tozalash Yo'riqnomasi:</b>\n\n` +
                     `1. "👤 Xodimlar Ro'yxati" sahifasiga o'ting va xodim ismi yonidagi "Jarima 0" tugmasini bosing.\n\n` +
                     `2. Yoki to'g'ridan-to'g'ri quyidagi buyruqni chatga yozib yuboring:\n` +
                     `<code>/clear &lt;telegram_id&gt;</code>\n\n` +
                     `💬 <b>Misol:</b>\n` +
                     `<code>/clear 5624377303</code>`;

        return ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "👤 Xodimlar", callback_data: "admin_employees_list" },
                { text: "🔙 Orqaga", callback_data: "admin_menu" }
              ]
            ]
          }
        }).catch(() => {});
      } else if (data.startsWith("clear_p_")) {
        const empId = data.replace("clear_p_", "");
        const emp = db.employees.find((e) => e.id === empId);
        if (emp) {
          let count = 0;
          db.attendance.forEach((att) => {
            if (att.employeeId === empId && att.penaltyAmount > 0) {
              att.penaltyAmount = 0;
              att.finalSalary = att.baseSalary + att.overtimeSalary;
              count++;
            }
          });
          writeDB(db);
          ctx.answerCbQuery(`🧼 ${emp.name} ning bugungi bekor qilinmagan barcha jarimalari tozalandi!`, { show_alert: true }).catch(() => {});
          return renderEmployeeList(ctx);
        } else {
          return ctx.answerCbQuery("❌ Xodim topilmadi!").catch(() => {});
        }
      } else if (data.startsWith("del_e_")) {
        const empId = data.replace("del_e_", "");
        const emp = db.employees.find((e) => e.id === empId);
        if (emp) {
          db.employees = db.employees.filter((e) => e.id !== empId);
          db.attendance = db.attendance.filter((att) => att.employeeId !== empId);
          writeDB(db);
          ctx.answerCbQuery(`❌ ${emp.name} ro'yxatdan va davomatlardan o'chirildi!`, { show_alert: true }).catch(() => {});
          return renderEmployeeList(ctx);
        } else {
          return ctx.answerCbQuery("❌ Xodim topilmadi!").catch(() => {});
        }
      }
    });

    // Command Tracker / Backup tools (As textual commands for admins who still prefer text)
    // Command: /add
    bot.command("add", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.reply("❌ Ushbu buyruq faqat adminlar uchun mo'ljallangan.");
      }

      const args = ctx.message.text.split(" ").slice(1);
      if (args.length < 2) {
        return ctx.reply("⚠️ To'g'ri foydalanish:\n/add <telegram_id> <Ism Sharif> <boshlash1> <tugash1> [boshlash2] [tugash2]\n\nMisol (1 navbat):\n/add 5624377303 Ergashev Sherzod 08:30 18:00\n\nMisol (2 navbat):\n/add 5624377303 Xoshimov Abdurasul 8:00 15:00 22:00 2:00");
      }

      const id = args[0];

      let name = "";
      let startTime = "09:00";
      let endTime = "18:00";
      let startTime2: string | null = null;
      let endTime2: string | null = null;

      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

      // Count how many trailing args are valid time strings (up to 4)
      let timeCount = 0;
      for (let i = args.length - 1; i >= 1 && timeCount < 4; i--) {
        if (timeRegex.test(args[i])) timeCount++;
        else break;
      }

      if (timeCount >= 4) {
        // 2 shifts provided: name start1 end1 start2 end2
        startTime = args[args.length - 4];
        endTime = args[args.length - 3];
        startTime2 = args[args.length - 2];
        endTime2 = args[args.length - 1];
        name = args.slice(1, args.length - 4).join(" ");
      } else if (timeCount >= 2) {
        // 1 shift provided: name start1 end1
        startTime = args[args.length - 2];
        endTime = args[args.length - 1];
        name = args.slice(1, args.length - 2).join(" ");
      } else if (timeCount === 1) {
        endTime = args[args.length - 1];
        name = args.slice(1, args.length - 1).join(" ");
      } else {
        name = args.slice(1).join(" ");
      }

      if (!name) {
        return ctx.reply("❌ Xodim ismi bo'sh bo'lishi mumkin emas.");
      }

      const shiftText = startTime2 && endTime2
        ? `1-navbat: ${startTime} - ${endTime}\n2-navbat: ${startTime2} - ${endTime2}`
        : `Ish vaqti: ${startTime} - ${endTime}`;

      const existing = db.employees.find((e) => e.telegramId === id);
      if (existing) {
        existing.name = name;
        existing.startTime = startTime;
        existing.endTime = endTime;
        existing.startTime2 = startTime2;
        existing.endTime2 = endTime2;
        ctx.reply(`✏️ Xodim ma'lumotlari yangilandi:\n👤 ${name}\n⏰ ${shiftText}`);
      } else {
        db.employees.push({
          id,
          name,
          telegramId: id,
          telegramUsername: null,
          startTime,
          endTime,
          startTime2,
          endTime2,
          createdAt: Date.now()
        });
        ctx.reply(`✅ Yangi xodim qo'shildi:\n👤 ${name}\n🆔 Telegram ID: ${id}\n⏰ ${shiftText}`);
      }

      writeDB(db);
    });

    // Command: /clear <id>
    bot.command("clear", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.reply("❌ Ushbu buyruq faqat adminlar uchun mo'ljallangan.");
      }

      const args = ctx.message.text.split(" ").slice(1);
      if (args.length < 1) {
        return ctx.reply("⚠️ To'g'ri foydalanish: /clear <telegram_id>");
      }

      const id = args[0];
      const emp = db.employees.find((e) => e.telegramId === id || e.telegramUsername === id);
      if (!emp) {
        return ctx.reply(`❌ Tizimda "${id}" IDli yoki foydalanuvchili xodim topilmadi.`);
      }

      let count = 0;
      db.attendance.forEach((att) => {
        if (att.employeeId === emp.id && att.penaltyAmount > 0) {
          att.penaltyAmount = 0;
          att.finalSalary = att.baseSalary + att.overtimeSalary;
          count++;
        }
      });

      writeDB(db);
      ctx.reply(`✅ ${emp.name} ning barcha jarimalari 0 qilindi (Jami ${count} ta davr vaqtlaridagi rekord o'zgartirildi).`);
    });

    // Command: /remove <id>
    bot.command("remove", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.reply("❌ Ushbu buyruq faqat adminlar uchun mo'ljallangan.");
      }

      const args = ctx.message.text.split(" ").slice(1);
      if (args.length < 1) {
        return ctx.reply("⚠️ To'g'ri foydalanish: /remove <telegram_id>");
      }

      const id = args[0];
      const initialCount = db.employees.length;
      db.employees = db.employees.filter((e) => e.telegramId !== id);

      if (db.employees.length < initialCount) {
        db.attendance = db.attendance.filter((att) => att.employeeId !== id);
        writeDB(db);
        ctx.reply(`✅ Xodim (Telegram ID: ${id}) ro'yxatdan o'chirildi.`);
      } else {
        ctx.reply(`❌ "${id}" telegram IDli xodim topilmadi.`);
      }
    });

    // Command: /report
    bot.command("report", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.reply("❌ Ushbu buyruq faqat adminlar uchun.");
      }

      const { dateStr } = getTashkentDateParts(ctx.message.date);
      const todayRecords = db.attendance.filter((att) => att.date === dateStr);

      if (todayRecords.length === 0) {
        return ctx.reply(`📅 ${dateStr} sanasi uchun hali hech qanday davomat qayd etilmagan.`);
      }

      let reportMsg = `📅 <b>Sana:</b> ${dateStr}\n` +
                      `👥 <b>Bugungi davomat hisoboti:</b>\n\n`;

      todayRecords.forEach((att) => {
        const checkInTime = att.checkIn ? getTashkentDateParts(att.checkIn).timeStr : "kelmagan";
        const checkOutTime = att.checkOut ? getTashkentDateParts(att.checkOut).timeStr : "ketmagan";
        const workedStr = att.workedMinutes > 0 ? `${Math.floor(att.workedMinutes / 60)}s ${att.workedMinutes % 60}m` : "-";
        const lateStr = att.latenessMinutes > 0 ? `⚠️ ${att.latenessMinutes} daqiqa` : "yo'q";
        const penaltyStr = att.penaltyAmount > 0 ? `${att.penaltyAmount.toLocaleString()} so'm` : "yo'q";
        
        reportMsg += `👤 <b>${att.name}</b>\n` +
                     `📥 Kelgan vaqti: ${checkInTime}\n` +
                     `📤 Ketgan vaqti: ${checkOutTime}\n` +
                     `⏰ Ishlangan vaqt: ${workedStr}\n` +
                     `⏱️ Kechikish: ${lateStr}\n` +
                     `💸 Jarima: ${penaltyStr}\n` +
                     `💵 To'lov: ${att.finalSalary.toLocaleString()} so'm\n` +
                     `---------------------------\n`;
      });

      ctx.replyWithHTML(reportMsg);
    });

    // Command: /stats
    bot.command("stats", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      if (!db.settings.adminIds.includes(fromId)) {
        return ctx.reply("❌ Ushbu buyruq faqat adminlar uchun.");
      }

      const totalEmp = db.employees.length;
      const totalPenalties = db.attendance.reduce((sum, item) => sum + item.penaltyAmount, 0);
      const totalWages = db.attendance.reduce((sum, item) => sum + item.finalSalary, 0);

      const statsMsg = `📊 <b>Tizimning umumiy statistikasi:</b>\n\n` +
                       `👥 Jami xodimlar: <b>${totalEmp} ta</b>\n` +
                       `💸 Jami jarimalar: <b>${totalPenalties.toLocaleString()} so'm</b>\n` +
                       `💵 Jami hisoblangan ish haqi: <b>${totalWages.toLocaleString()} so'm</b>\n\n` +
                       `Batafsil ma'lumotlar va qulay filtrlar uchun Web Dashboard'ga kiring!`;

      ctx.replyWithHTML(statsMsg);
    });

    // Forward an employee's video note to all admins along with their tracking info
    const notifyAdminsWithVideo = (
      ctx: any,
      db: DBData,
      employee: { id: string; name: string; telegramId: string | null; telegramUsername: string | null },
      type: "checkin" | "checkout",
      timeStr: string,
      dateStr: string,
      extraInfo: string
    ) => {
      const typeLabel = type === "checkin" ? "📥 KELDI (Check-in)" : "📤 KETDI (Check-out)";
      const caption =
        `${typeLabel}\n\n` +
        `👤 <b>Xodim:</b> ${employee.name}\n` +
        `🆔 <b>Telegram ID:</b> <code>${employee.telegramId || "yo'q"}</code>\n` +
        `👤 <b>Username:</b> ${employee.telegramUsername ? "@" + employee.telegramUsername : "yo'q"}\n` +
        `📅 <b>Sana:</b> ${dateStr}\n` +
        `⏰ <b>Vaqt:</b> ${timeStr}\n` +
        `${extraInfo}`;

      db.settings.adminIds.forEach((adminId) => {
        ctx.telegram
          .sendVideoNote(adminId, ctx.message.video_note.file_id)
          .then(() => {
            ctx.telegram.sendMessage(adminId, caption, { parse_mode: "HTML" }).catch(() => {});
          })
          .catch((err: any) => {
            console.error(`Failed to forward video note to admin ${adminId}:`, err?.message || err);
          });
      });
    };

    // Handle Circular Video Notes (video_note)
    bot.on("video_note", (ctx) => {
      const fromId = String(ctx.from.id);
      const db = readDB();
      const employee = db.employees.find((e) => e.telegramId === fromId || e.telegramUsername === ctx.from.username);

      if (!employee) {
        return ctx.replyWithHTML(
          `❌ Siz hali tizimda ro'yxatdan o'tmagansiz.\n` +
          `🆔 Telegram ID: <code>${fromId}</code>\n` +
          `Tizimdan foydalanish uchun ushbu IDni adminingizga yuboring.`
        );
      }

      // Upgrade telegram details
      if (!employee.telegramId) {
        employee.telegramId = fromId;
      }
      if (ctx.from.username && employee.telegramUsername !== ctx.from.username) {
        employee.telegramUsername = ctx.from.username;
      }

      const messageEpoch = ctx.message.date; // Seconds (Telegram server time)
      const { dateStr, timeStr, monthIndex } = getTashkentDateParts(messageEpoch);

      // Check if attendance record already exists for today
      let record = db.attendance.find((r) => r.employeeId === employee.id && r.date === dateStr);

      if (!record) {
        // --- CHECK IN MODE ---
        // Calc lateness
        const startMinutes = timeStringToMinutes(employee.startTime);
        const actualMinutes = timeStringToMinutes(timeStr);
        const latenessMinutes = actualMinutes - startMinutes;

        let penaltyAmount = 0;
        let warningText = "Kechikish yo'q. Baraka toping!";

        if (latenessMinutes > 0 && latenessMinutes <= 10) {
          warningText = `⚠️ Siz ${latenessMinutes} daqiqa kechikdingiz. 10 daqiqagacha kechikish jazolanmaydi. Quyidagi safar intizomli bo'ling!`;
        } else if (latenessMinutes > 10) {
          penaltyAmount = latenessMinutes * 1000;
          warningText = `🚨 Siz ${latenessMinutes} daqiqa kechikdingiz! ${latenessMinutes} daqiqa × 1 000 so'm = ${penaltyAmount.toLocaleString()} so'm JARIMA hisoblandi.`;
        }

        const newRecord = {
          id: `${employee.id}_${dateStr}`,
          employeeId: employee.id,
          name: employee.name,
          date: dateStr,
          checkIn: messageEpoch,
          checkOut: null,
          checkInVideoId: ctx.message.video_note.file_id,
          checkOutVideoId: null,
          workedMinutes: 0,
          latenessMinutes: Math.max(0, latenessMinutes),
          penaltyAmount,
          baseSalary: 0,
          overtimeSalary: 0,
          finalSalary: 0,
          isCompleted: false
        };

        db.attendance.push(newRecord);
        writeDB(db);

        const checkInMsg = `📥 <b>Kelingiz qayd etildi!</b>\n\n` +
                           `👤 <b>Xodim:</b> ${employee.name}\n` +
                           `📅 <b>Sana:</b> ${dateStr}\n` +
                           `⏰ <b>Kelgan vaqtingiz:</b> ${timeStr}\n` +
                           `⏱️ Belgilangan ish vaqti: ${employee.startTime}${employee.startTime2 && employee.endTime2 ? ` / ${employee.startTime2} - ${employee.endTime2}` : ''}\n\n` +
                           `${warningText}\n\n` +
                           `💼 Ish tugagach, yana bitta yumaloq video yuborishni unutmang.`;

        ctx.replyWithHTML(checkInMsg);

        const checkInExtraInfo =
          latenessMinutes > 0
            ? `⏱️ <b>Kechikish:</b> ${Math.max(0, latenessMinutes)} daqiqa\n💸 <b>Jarima:</b> ${penaltyAmount.toLocaleString()} so'm`
            : `✅ Kechikishsiz keldi`;
        notifyAdminsWithVideo(ctx, db, employee, "checkin", timeStr, dateStr, checkInExtraInfo);
      } else if (!record.isCompleted) {
        // --- CHECK OUT MODE ---
        if (record.checkIn && messageEpoch <= record.checkIn) {
          return ctx.reply("⚠️ Xatolik: Ketgan vaqtingiz kelgan vaqtingizdan oldin bo'la olmaydi!");
        }

        const checkInEpoch = record.checkIn || 0;
        const workedMinutes = Math.floor((messageEpoch - checkInEpoch) / 60);

        // Determine current Season
        // Summer: April (index 3) to October (index 9) inclusive
        const isSummer = monthIndex >= 3 && monthIndex <= 9;
        const seasonName = isSummer ? "Yoz" : "Qish";

        let baseSalary = 0;
        let overtimeSalary = 0;

        // Wage Rules
        if (isSummer) {
          // Summer: First 10 hours rate is 6500, rest is 7000. Limit is 10h = 600m
          if (workedMinutes <= 600) {
            baseSalary = Math.round(workedMinutes * (db.settings.summerRate / 60));
          } else {
            baseSalary = 10 * db.settings.summerRate;
            overtimeSalary = Math.round((workedMinutes - 600) * (db.settings.summerOvertimeRate / 60));
          }
        } else {
          // Winter: First 9 hours rate is 6500, rest is 7000. Limit is 9h = 540m
          if (workedMinutes <= 540) {
            baseSalary = Math.round(workedMinutes * (db.settings.winterRate / 60));
          } else {
            baseSalary = 9 * db.settings.winterRate;
            overtimeSalary = Math.round((workedMinutes - 540) * (db.settings.winterOvertimeRate / 60));
          }
        }

        const penalty = record.penaltyAmount;
        const rawSalary = baseSalary + overtimeSalary;
        const finalSalary = Math.max(0, rawSalary - penalty);

        // Update Record
        record.checkOut = messageEpoch;
        record.checkOutVideoId = ctx.message.video_note.file_id;
        record.workedMinutes = workedMinutes;
        record.baseSalary = baseSalary;
        record.overtimeSalary = overtimeSalary;
        record.finalSalary = finalSalary;
        record.isCompleted = true;

        writeDB(db);

        const hours = Math.floor(workedMinutes / 60);
        const mins = workedMinutes % 60;

        const checkOutMsg = `📤 <b>Ketishingiz qayd etildi!</b>\n\n` +
                            `👤 <b>Xodim:</b> ${employee.name}\n` +
                            `📅 <b>Sana:</b> ${dateStr}\n` +
                            `⏰ <b>Ketgan vaqtingiz:</b> ${timeStr}\n` +
                            `💼 <b>Ishlangan umumiy vaqt:</b> ${hours} soat ${mins} daqiqa\n` +
                            `🍁 <b>Mavsum:</b> ${seasonName}\n\n` +
                            `💵 <b>Oddiy ish haqi:</b> ${baseSalary.toLocaleString()} so'm\n` +
                            `➕ <b>Overtime ish haqi:</b> ${overtimeSalary.toLocaleString()} so'm\n` +
                            `⚠️ <b>Kechikish jarimasi:</b> ${penalty.toLocaleString()} so'm\n` +
                            `💰 <b>Sizga yozilgan yakuniy to'lov:</b> <u>${finalSalary.toLocaleString()} so'm</u>\n\n` +
                            `Kuningiz xayrli o'tsin!`;

        ctx.replyWithHTML(checkOutMsg);

        const checkOutExtraInfo =
          `💼 <b>Ishladi:</b> ${hours} soat ${mins} daqiqa\n` +
          `🍁 <b>Mavsum:</b> ${seasonName}\n` +
          `💰 <b>Yakuniy to'lov:</b> ${finalSalary.toLocaleString()} so'm`;
        notifyAdminsWithVideo(ctx, db, employee, "checkout", timeStr, dateStr, checkOutExtraInfo);
      } else {
        // Already checked in and checked out
        const { timeStr: checkInTime } = getTashkentDateParts(record.checkIn || 0);
        const { timeStr: checkOutTime } = getTashkentDateParts(record.checkOut || 0);
        ctx.replyWithHTML(
          `📅 Bugun <b>${dateStr}</b> uchun siz kelib-ketganingiz qayd etib bo'lingan!\n` +
          `📥 Kelgan vaqt: ${checkInTime}\n` +
          `📤 Ketgan vaqt: ${checkOutTime}\n\n` +
          `Ertaga ko'rishguncha!`
        );
      }
    });

    // Run Bot in Webhook or Polling mode depending on RENDER_EXTERNAL_URL / WEBHOOK_URL presence
    const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
    if (publicUrl) {
      const cleanToken = encodeURIComponent(token.trim());
      const finalWebhookUrl = `${publicUrl.replace(/\/$/, "")}/webhook/${cleanToken}`;
      console.log(`Setting Telegram Webhook endpoint to: ${finalWebhookUrl}`);
      
      bot.telegram.setWebhook(finalWebhookUrl)
        .then(() => {
          console.log("Telegram Bot webhook setup initialized successfully!");
          botStatus = "active";
          botError = null;
        })
        .catch((err) => {
          console.error("Failed to register Telegram Webhook on secure endpoint:", err);
          botError = `Webhook xatosi: ${err.message}`;
          botStatus = "error";
        });
    } else {
      console.log("No public URL environment variable found. Reverting to standard Long Polling...");
      bot.telegram.deleteWebhook({ drop_pending_updates: true })
        .then(() => {
          return bot!.launch();
        })
        .then(() => {
          console.log("Telegram Bot client successfully running via Polling mode.");
          botStatus = "active";
          botError = null;
        })
        .catch((err) => {
          console.error("Failed to run Telegram Bot via polling", err);
          botError = `Polling xatosi: ${err.message}`;
          botStatus = "error";
        });
    }

  } catch (err: any) {
    console.error("Critical Bot initialization error on load sequence:", err);
    botError = err.message;
    botStatus = "error";
  }
}

// Complete bootstrap routine with database mapping
async function bootstrapApp() {
  if (pool) {
    await initDatabaseSchema();
    const pgData = await loadFromPostgres();
    if (pgData) {
      dbInMemoryCache = pgData;
      console.log("Mapped and synchronized cache from persistent Cloud PostgreSQL database.");
    } else {
      console.log("Target Cloud DB empty. Synced model caches from fallback records...");
      const initialJsonData = readDB();
      dbInMemoryCache = initialJsonData;
      await saveToPostgres(initialJsonData).then(() => {
        console.log("Seeded and synchronized local configurations to Postgres database.");
      }).catch((e) => {
        console.error("Failed to populate initial Postgres dataset:", e);
      });
    }
  } else {
    // Pure offline JSON cache
    dbInMemoryCache = readDB();
    console.log("Running in zero-config offline mode with filesystem database.");
  }

  // Trigger Telegraf initialization with the active configuration
  initializeBot();
}

// Fire async bootstrap on start
bootstrapApp();


// API ENDPOINTS

// 1. Employee Management
app.get("/api/employees", (req, res) => {
  const db = readDB();
  res.json(db.employees);
});

app.post("/api/employees", (req, res) => {
  const db = readDB();
  const { id, name, startTime, endTime, telegramId } = req.body;

  if (!id || !name) {
    return res.status(400).json({ error: "ID va Ism kiritilishi shart." });
  }

  // Check if exists
  const existing = db.employees.find((e) => e.id === id);
  if (existing) {
    return res.status(400).json({ error: "Ushbu ID li xodim allaqachon mavjud." });
  }

  const newEmployee = {
    id,
    name,
    telegramId: telegramId || id,
    telegramUsername: null,
    startTime: startTime || "09:00",
    endTime: endTime || "18:00",
    createdAt: Date.now()
  };

  db.employees.push(newEmployee);
  writeDB(db);
  res.json({ success: true, employee: newEmployee });
});

app.put("/api/employees/:id", (req, res) => {
  const db = readDB();
  const { id } = req.params;
  const { name, startTime, endTime, telegramId } = req.body;

  const emp = db.employees.find((e) => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: "Xodim topilmadi." });
  }

  if (name) emp.name = name;
  if (startTime) emp.startTime = startTime;
  if (endTime) emp.endTime = endTime;
  if (telegramId !== undefined) emp.telegramId = telegramId;

  writeDB(db);
  res.json({ success: true, employee: emp });
});

app.delete("/api/employees/:id", (req, res) => {
  const db = readDB();
  const { id } = req.params;

  const initialCount = db.employees.length;
  db.employees = db.employees.filter((e) => e.id !== id);

  if (db.employees.length < initialCount) {
    // Optionally remove related attendance
    db.attendance = db.attendance.filter((att) => att.employeeId !== id);
    writeDB(db);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Xodim topilmadi." });
  }
});


// 2. Attendance Records & Operations
app.get("/api/attendance", (req, res) => {
  const db = readDB();
  const { employeeId, date, month } = req.query;

  let records = db.attendance;

  if (employeeId) {
    records = records.filter((r) => r.employeeId === employeeId);
  }
  if (date) {
    records = records.filter((r) => r.date === date);
  }
  if (month) {
    // month is format YYYY-MM
    records = records.filter((r) => r.date.startsWith(month as string));
  }

  res.json(records);
});

// Clear Penalty API
app.post("/api/attendance/clear-penalty", (req, res) => {
  const db = readDB();
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({ error: "Xodim ID kiritilmadi." });
  }

  let count = 0;
  db.attendance.forEach((att) => {
    if (att.employeeId === employeeId && att.penaltyAmount > 0) {
      att.penaltyAmount = 0;
      att.finalSalary = att.baseSalary + att.overtimeSalary; // Recalculate salary
      count++;
    }
  });

  writeDB(db);
  res.json({ success: true, clearedCount: count });
});


// 3. Stats & Dashboard Analytics
app.get("/api/stats", (req, res) => {
  const db = readDB();
  const employees = db.employees;
  const attendance = db.attendance;

  const todayStr = new Date().toISOString().split("T")[0];
  const activeToday = attendance.filter((r) => r.date === todayStr);

  const currentMonthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const currentMonthRecords = attendance.filter((r) => r.date.startsWith(currentMonthPrefix));

  const totalPenaltiesThisMonth = currentMonthRecords.reduce((sum, item) => sum + (item.penaltyAmount || 0), 0);
  const totalWagesThisMonth = currentMonthRecords.reduce((sum, item) => sum + (item.finalSalary || 0), 0);
  const latenessWarningCountToday = activeToday.filter((r) => r.latenessMinutes > 0 && r.penaltyAmount === 0).length;

  res.json({
    totalEmployees: employees.length,
    todayActiveCount: activeToday.length,
    totalPenaltiesThisMonth,
    totalWagesThisMonth,
    latenessWarningCountToday
  });
});


// 4. Settings Configuration
app.get("/api/settings", (req, res) => {
  const db = readDB();
  const token = db.settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "";
  const cleanToken = encodeURIComponent(token.trim());
  
  res.json({
    settings: db.settings,
    botStatus,
    botError,
    isPostgres: !!pool,
    webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, "")}/webhook/${cleanToken}` : null
  });
});

app.post("/api/settings", (req, res) => {
  const db = readDB();
  const { adminIds, summerRate, summerOvertimeRate, winterRate, winterOvertimeRate, botToken } = req.body;

  if (adminIds) db.settings.adminIds = adminIds;
  if (summerRate !== undefined) db.settings.summerRate = Number(summerRate);
  if (summerOvertimeRate !== undefined) db.settings.summerOvertimeRate = Number(summerOvertimeRate);
  if (winterRate !== undefined) db.settings.winterRate = Number(winterRate);
  if (winterOvertimeRate !== undefined) db.settings.winterOvertimeRate = Number(winterOvertimeRate);
  
  const tokenChanged = botToken !== undefined && botToken !== db.settings.botToken;
  if (botToken !== undefined) db.settings.botToken = botToken;

  writeDB(db);

  if (tokenChanged) {
    console.log("Bot Token changed, reinitializing client...");
    initializeBot();
  }

  const token = db.settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "";
  const cleanToken = encodeURIComponent(token.trim());

  res.json({ 
    success: true, 
    settings: db.settings, 
    botStatus, 
    botError,
    isPostgres: !!pool,
    webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, "")}/webhook/${cleanToken}` : null
  });
});

// Telegram Webhook Handler Route
app.post("/webhook/:botTokenPath", (req, res) => {
  const db = readDB();
  const token = db.settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const cleanToken = encodeURIComponent(token.trim());

  if (req.params.botTokenPath === cleanToken && bot) {
    bot.handleUpdate(req.body, res)
      .then(() => {
        if (!res.headersSent) {
          res.sendStatus(200);
        }
      })
      .catch((err) => {
        console.error("Error handling webhook update:", err);
        if (!res.headersSent) {
          res.sendStatus(500);
        }
      });
  } else {
    res.status(403).send("Secret token mismatch or bot uninitialized.");
  }
});


// VITE DEVELOPMENT MIDDLEWARE / PRODUCTION STATIC SERVING
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express Service listening dynamically on http://0.0.0.0:${PORT}`);
  });
}

startServer();
