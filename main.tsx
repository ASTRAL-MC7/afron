export interface Employee {
  id: string; // The employee's unique ID (can be Telegram ID or custom string)
  name: string;
  telegramId: string | null;
  telegramUsername: string | null;
  startTime: string; // "HH:MM", e.g., "09:00"
  endTime: string; // "HH:MM", e.g., "18:00"
  createdAt: number;
}

export interface PenaltyRecord {
  id: string;
  employeeId: string;
  date: string; // YYYY-MM-DD
  minutesLate: number;
  amount: number;
  description: string;
  timestamp: number;
  cleared: boolean;
}

export interface AttendanceRecord {
  id: string; // employeeId_date
  employeeId: string;
  name: string;
  date: string; // YYYY-MM-DD
  checkIn: number | null; // Unix timestamp (seconds)
  checkOut: number | null; // Unix timestamp (seconds)
  checkInVideoId: string | null; // Telegram video note file_id
  checkOutVideoId: string | null;
  workedMinutes: number;
  latenessMinutes: number;
  penaltyAmount: number;
  baseSalary: number;
  overtimeSalary: number;
  finalSalary: number;
  isCompleted: boolean;
  notes?: string;
}

export interface Settings {
  adminIds: string[]; // Whitelist of admin Telegram IDs
  botToken: string | null;
  summerRate: number; // default 6500
  summerOvertimeRate: number; // default 7000
  winterRate: number; // default 6500
  winterOvertimeRate: number; // default 7000
}

export interface DashboardStats {
  totalEmployees: number;
  todayActiveCount: number;
  totalPenaltiesThisMonth: number;
  totalWagesThisMonth: number;
  latenessWarningCountToday: number;
}
