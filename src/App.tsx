import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from './supabaseClient';
import { 
  Power, Droplets, Thermometer, ShieldCheck, 
  Lock, Wind, Snowflake, SunDim, Sparkles, 
  Moon, Clock, ChevronUp, ChevronDown, CheckCircle2,
  LineChart as ChartIcon, Sliders, Activity, RefreshCw, 
  Loader2
} from 'lucide-react';

interface ACState {
  id: number;
  power: boolean;
  mode: 'cool' | 'dry' | 'off';
  target_temp: number;
  fan_speed: string;
  is_auto: boolean;
  last_command_code: string;
  session_started_at?: string | null;
  updated_at?: string;
}

interface SensorLog {
  id: number;
  temperature: number;
  humidity: number;
  ac_mode?: string;
  created_at: string;
}

interface SleepSession {
  id?: number;
  started_at: string;
  ended_at?: string;
  duration_minutes?: number;
  avg_temp?: number;
  avg_humidity?: number;
  dry_mode_count?: number;
}

const PIN_KEY = 'app_pin_unlocked';
const SYSTEM_PIN = '1234';
const MIN_SLEEP_THRESHOLD_MINS = 15;

// ฟังก์ชันคำนวณรหัส LG 28-bit ตรงตามเฟิร์มแวร์ ESP32
const calculateLgHex = (power: boolean, mode: string, temp: number): string => {
  if (!power) return '0x88C0051';
  if (mode === 'dry') return '0x880194E';
  const clamped = Math.min(Math.max(temp, 18), 30);
  const tempNibble = clamped - 15;
  const fanNibble = 4;
  const checksum = (8 + 8 + 0 + 0 + tempNibble + fanNibble) & 0x0F;
  return `0x8800${tempNibble.toString(16).toUpperCase()}${fanNibble}${checksum.toString(16).toUpperCase()}`;
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [currentTab, setCurrentTab] = useState<'control' | 'analytics'>('control');
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // สถานะแอร์: ซิงก์ตรงกับ Supabase (ไม่มี Mock Data)
  const [acState, setAcState] = useState<ACState | null>(null);
  
  // สถานะเซนเซอร์ DHT22 สดจาก Supabase
  const [sensor, setSensor] = useState<{ temperature: number | null; humidity: number | null }>({ 
    temperature: null, 
    humidity: null 
  });
  
  const [inBedDurationMins, setInBedDurationMins] = useState<number>(0);

  // ข้อมูลจริงจาก sensor_logs และ sleep_sessions
  const [historyLogs, setHistoryLogs] = useState<SensorLog[]>([]);
  const [sleepSessions, setSleepSessions] = useState<SleepSession[]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<SensorLog | null>(null);
  const [logRange, setLogRange] = useState<number>(60); // 60 นาทีล่าสุด

  // Ref สำหรับล็อกสิทธิ์คำสั่งผู้ใช้ (ป้องกันบอร์ดส่งค่าเก่ามาทับ)
  const manualOverrideLockUntil = useRef<number>(0);

  // Ref สำหรับเลื่อนกราฟแนวนอน
  const chartScrollRef = useRef<HTMLDivElement>(null);

  // Touch handlers สำหรับ Swipe สลับหน้าจอ
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  useEffect(() => {
    if (localStorage.getItem(PIN_KEY) === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  // ตัวนับเวลาเปิดแอร์จริงในห้อง
  useEffect(() => {
    if (!acState || !acState.power) {
      setInBedDurationMins(0);
      return;
    }

    const startTimeStr = acState.session_started_at || acState.updated_at;
    if (!startTimeStr) return;

    const updateDuration = () => {
      const diffMs = Date.now() - new Date(startTimeStr).getTime();
      setInBedDurationMins(Math.max(0, Math.floor(diffMs / 60000)));
    };

    updateDuration();
    const interval = setInterval(updateDuration, 10000);
    return () => clearInterval(interval);
  }, [acState]);

  // ดึงข้อมูลวิเคราะห์ทั้งหมดจาก Supabase
  const fetchAnalyticsData = async () => {
    setRefreshing(true);
    try {
      const { data: logs, error: logsErr } = await supabase
        .from('sensor_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(logRange);

      if (!logsErr && logs && logs.length > 0) {
        const parsedLogs: SensorLog[] = logs.map(l => ({
          ...l,
          temperature: Number(l.temperature),
          humidity: Number(l.humidity)
        }));
        const chronological = [...parsedLogs].reverse();
        setHistoryLogs(chronological);
        
        const latest = parsedLogs[0];
        setSensor({ 
          temperature: latest.temperature, 
          humidity: latest.humidity 
        });
      }

      const { data: sessions, error: sessErr } = await supabase
        .from('sleep_sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10);

      if (!sessErr && sessions) {
        setSleepSessions(sessions);
      }
    } catch (err) {
      console.error('Error fetching analytics:', err);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchInitial = async () => {
      const { data: ac } = await supabase.from('ac_control').select('*').eq('id', 1).single();
      if (ac) setAcState(ac);
      await fetchAnalyticsData();
    };

    fetchInitial();

    // ฟัง Realtime การควบคุมแอร์ (พร้อม Grace Period Guard)
    const acChannel = supabase
      .channel('realtime_ac_control')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ac_control' }, (payload) => {
        // หากผู้ใช้เพิ่งกดปุ่มไม่เกิน 6 วินาที ให้ข้ามข้อมูลเก่าที่บอร์ดอาจเพิ่งยิงขึ้นมา
        if (Date.now() < manualOverrideLockUntil.current) {
          return;
        }
        if (payload.new && (payload.new as ACState).id === 1) {
          setAcState(payload.new as ACState);
        }
      })
      .subscribe();

    // ฟัง Realtime ข้อมูลเซนเซอร์จาก ESP32
    const sensorChannel = supabase
      .channel('realtime_sensor_logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_logs' }, (payload) => {
        const rawLog = payload.new as SensorLog;
        const newLog: SensorLog = {
          ...rawLog,
          temperature: Number(rawLog.temperature),
          humidity: Number(rawLog.humidity)
        };
        setSensor({
          temperature: newLog.temperature,
          humidity: newLog.humidity
        });
        setHistoryLogs((prev) => {
          const next = [...prev, newLog];
          return next.length > logRange ? next.slice(next.length - logRange) : next;
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(acChannel);
      supabase.removeChannel(sensorChannel);
    };
  }, [isAuthenticated, logRange]);

  // เลื่อนกราฟไปทางขวาสุด (จุดเวลาล่าสุด) เมื่อโหลดข้อมูลเสร็จ
  useEffect(() => {
    if (currentTab === 'analytics' && chartScrollRef.current) {
      setTimeout(() => {
        if (chartScrollRef.current) {
          chartScrollRef.current.scrollTo({
            left: chartScrollRef.current.scrollWidth,
            behavior: 'smooth'
          });
        }
      }, 150);
    }
  }, [currentTab, historyLogs.length]);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinInput === SYSTEM_PIN) {
      localStorage.setItem(PIN_KEY, 'true');
      setIsAuthenticated(true);
    } else {
      alert('รหัส PIN ไม่ถูกต้อง');
      setPinInput('');
    }
  };

  const handleSleepSessionEnd = async (startTimeStr: string) => {
    const endTime = new Date();
    const startTime = new Date(startTimeStr);
    const durationMins = Math.floor((endTime.getTime() - startTime.getTime()) / 60000);

    if (durationMins >= MIN_SLEEP_THRESHOLD_MINS) {
      const { data: logs } = await supabase
        .from('sensor_logs')
        .select('temperature, humidity, ac_mode')
        .gte('created_at', startTime.toISOString())
        .lte('created_at', endTime.toISOString());

      let avgT = sensor.temperature ?? 26.0;
      let avgH = sensor.humidity ?? 55.0;
      let dryCount = 0;

      if (logs && logs.length > 0) {
        const validTemps = logs.map(l => Number(l.temperature)).filter(v => !isNaN(v));
        const validHums = logs.map(l => Number(l.humidity)).filter(v => !isNaN(v));
        if (validTemps.length > 0) avgT = Number((validTemps.reduce((a, b) => a + b, 0) / validTemps.length).toFixed(1));
        if (validHums.length > 0) avgH = Number((validHums.reduce((a, b) => a + b, 0) / validHums.length).toFixed(1));
        dryCount = logs.filter(l => l.ac_mode === 'dry').length;
      }

      const newSession = {
        started_at: startTime.toISOString(),
        ended_at: endTime.toISOString(),
        duration_minutes: durationMins,
        avg_temp: avgT,
        avg_humidity: avgH,
        dry_mode_count: dryCount
      };

      const { data } = await supabase.from('sleep_sessions').insert([newSession]).select().single();
      if (data) {
        setSleepSessions(prev => [data, ...prev]);
      }
    }
  };

  // จัดการอัปเดตสถานะแบบ Single Source of Truth พร้อม Auto-Disarm
  const updateState = async (updates: Partial<ACState>) => {
    if (!acState) return;
    setLoading(true);

    // ล็อกสิทธิ์หน้าจอไว้ 6 วินาที เพื่อไม่ให้ Realtime จากบอร์ดมาเด้งทับ
    manualOverrideLockUntil.current = Date.now() + 6000;

    // ตรวจสอบว่าเป็นการกดปุ่มสลับ Auto Guard ตรงๆ หรือเกิดจากการกดสั่งแอร์ทั่วไป
    const isExplicitAutoToggle = updates.is_auto !== undefined && Object.keys(updates).length === 1;
    // หากเป็นการกดสั่งแอร์ทั่วไป ให้บังคับปลด Auto Guard ทิ้ง (is_auto = false) ทันที
    const nextAuto = isExplicitAutoToggle ? updates.is_auto! : false;

    const nextPower = updates.power !== undefined ? updates.power : acState.power;
    const nextMode = updates.mode !== undefined ? updates.mode : acState.mode;
    const nextTemp = updates.target_temp !== undefined ? updates.target_temp : acState.target_temp;
    const nextHex = calculateLgHex(nextPower, nextMode, nextTemp);

    let sessionStartedAt = acState.session_started_at;

    if (updates.power !== undefined) {
      if (updates.power && !acState.power) {
        sessionStartedAt = new Date().toISOString();
      } else if (!updates.power && acState.power) {
        const activeStart = acState.session_started_at || acState.updated_at;
        if (activeStart) {
          await handleSleepSessionEnd(activeStart);
        }
        sessionStartedAt = null;
      }
    }

    const payload: Partial<ACState> = {
      ...updates,
      power: nextPower,
      mode: nextMode,
      target_temp: nextTemp,
      is_auto: nextAuto,
      last_command_code: nextHex,
      session_started_at: sessionStartedAt,
      updated_at: new Date().toISOString()
    };

    // อัปเดตหน้าจอทันที (Optimistic UI)
    setAcState((prev) => prev ? ({ ...prev, ...payload }) : null);

    try {
      await supabase.from('ac_control').update(payload).eq('id', 1);
    } catch (err) {
      console.error('Failed to update ac_control:', err);
    } finally {
      setLoading(false);
    }
  };

  // ตรวจจับท่าทาง Swipe สลับแท็บบนหน้าจอมือถือ
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
    touchEndX.current = null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    if (distance > 70 && currentTab === 'control') {
      setCurrentTab('analytics');
      fetchAnalyticsData();
    } else if (distance < -70 && currentTab === 'analytics') {
      setCurrentTab('control');
    }
  };

  // คำนวณสถิติจากประวัติจริง ป้องกันข้อผิดพลาด NaN
  const stats = useMemo(() => {
    if (historyLogs.length === 0) {
      return { minT: null, maxT: null, avgT: null, minH: null, maxH: null, avgH: null, optimalPercent: 0, lastSeenMins: null };
    }
    const temps = historyLogs.map(l => Number(l.temperature)).filter(v => !isNaN(v));
    const hums = historyLogs.map(l => Number(l.humidity)).filter(v => !isNaN(v));

    if (temps.length === 0 || hums.length === 0) {
      return { minT: null, maxT: null, avgT: null, minH: null, maxH: null, avgH: null, optimalPercent: 0, lastSeenMins: null };
    }

    const minT = Math.min(...temps);
    const maxT = Math.max(...temps);
    const avgT = (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
    const minH = Math.min(...hums);
    const maxH = Math.max(...hums);
    const avgH = (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1);

    const optimalCount = historyLogs.filter(
      l => l.humidity >= 50 && l.humidity <= 58 && l.temperature >= 25 && l.temperature <= 26.5
    ).length;
    const optimalPercent = Math.round((optimalCount / historyLogs.length) * 100);

    const latestLogTime = new Date(historyLogs[historyLogs.length - 1].created_at).getTime();
    const lastSeenMins = Math.floor((Date.now() - latestLogTime) / 60000);

    return { minT, maxT, avgT, minH, maxH, avgH, optimalPercent, lastSeenMins };
  }, [historyLogs]);

  // คำนวณพิกัดกราฟ SVG แบบ Dynamic Width
  const chartData = useMemo(() => {
    if (historyLogs.length < 2) return null;
    const pointSpacing = 22;
    const paddingLeft = 35;
    const paddingRight = 35;
    const height = 200;
    const paddingTop = 20;
    const paddingBottom = 30;

    const width = Math.max(500, paddingLeft + paddingRight + (historyLogs.length - 1) * pointSpacing);

    const tMin = 20, tMax = 35;
    const hMin = 30, hMax = 90;

    const getX = (i: number) => paddingLeft + i * pointSpacing;
    const getYT = (val: number) => height - paddingBottom - ((val - tMin) / (tMax - tMin)) * (height - paddingTop - paddingBottom);
    const getYH = (val: number) => height - paddingBottom - ((val - hMin) / (hMax - hMin)) * (height - paddingTop - paddingBottom);

    let tempPath = `M ${getX(0)} ${getYT(Number(historyLogs[0].temperature))}`;
    let humPath = `M ${getX(0)} ${getYH(Number(historyLogs[0].humidity))}`;

    const dots = historyLogs.map((log, i) => {
      const x = getX(i);
      const yt = getYT(Number(log.temperature));
      const yh = getYH(Number(log.humidity));
      if (i > 0) {
        tempPath += ` L ${x} ${yt}`;
        humPath += ` L ${x} ${yh}`;
      }
      return { x, yt, yh, log, index: i };
    });

    return { tempPath, humPath, dots, width, height, getYH, getYT, paddingLeft, paddingRight, paddingTop, paddingBottom };
  }, [historyLogs]);

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#070b14] px-6 text-white font-sans">
        <form onSubmit={handlePinSubmit} className="w-full max-w-xs rounded-3xl bg-slate-900/80 p-8 text-center border border-slate-800 shadow-2xl backdrop-blur-xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Lock className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100">Climate Gate</h2>
          <p className="mt-1 mb-6 text-xs text-slate-400">ระบุรหัส 4 หลักเพื่อเข้าสู่ระบบ</p>
          <input
            type="password"
            maxLength={4}
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="mb-6 w-full rounded-2xl bg-slate-950 py-3.5 text-center text-3xl font-mono tracking-[0.4em] text-cyan-400 border border-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 transition"
            placeholder="••••"
            autoFocus
          />
          <button type="submit" className="w-full rounded-2xl bg-cyan-500 py-3.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 active:scale-[0.98]">
            ปลดล็อกระบบ
          </button>
        </form>
      </div>
    );
  }

  if (!acState) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-[#070b14] text-white font-sans gap-3">
        <Loader2 className="h-8 w-8 text-cyan-400 animate-spin" />
        <span className="text-sm font-medium text-slate-400 tracking-wide">กำลังเชื่อมต่อข้อมูลเรียลไทม์...</span>
      </div>
    );
  }

  const isDry = acState.power && acState.mode === 'dry';
  const isCool = acState.power && acState.mode === 'cool';
  const isHighHumidity = (sensor.humidity ?? 0) >= 62.0;
  const isOptimal = (sensor.humidity ?? 0) >= 50 && (sensor.humidity ?? 0) <= 58 && (sensor.temperature ?? 0) >= 25.0 && (sensor.temperature ?? 0) <= 26.5;

  return (
    <div 
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="min-h-[100dvh] bg-[#070b14] text-slate-100 flex flex-col items-center justify-between p-4 pb-20 font-sans select-none antialiased"
    >
      {/* 1. Header Bar */}
      <header className="w-full max-w-md flex items-center justify-between pt-1 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight text-white">LG Climate Hub</h1>
            <span className="flex h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse" />
          </div>
          <p className="text-[11px] font-medium text-slate-400 tracking-wide">ห้องนอน 7.7 m² • S13LCN</p>
        </div>

        {/* ปุ่มสลับโหมด Auto Guard เฉพาะจุดนี้เท่านั้นที่กดเปลี่ยนค่า is_auto ตรงๆ */}
        <button 
          disabled={loading}
          onClick={() => updateState({ is_auto: !acState.is_auto })}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold transition active:scale-95 ${
            acState.is_auto 
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.15)]' 
              : 'bg-slate-900 border-slate-800 text-slate-500'
          }`}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {acState.is_auto ? 'Auto Guard ON' : 'Manual'}
        </button>
      </header>

      {/* ======================= TAB 1: ควบคุมแอร์ (REMOTE CONTROL) ======================= */}
      {currentTab === 'control' && (
        <div className="w-full max-w-md flex-1 flex flex-col justify-between py-1 animate-fadeIn">
          {/* Room Sensor Badges */}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-slate-900/60 border border-slate-800/80 p-3.5 flex items-center gap-3 backdrop-blur-md">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <Thermometer className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">อุณหภูมิห้อง</div>
                  <div className="text-xl font-bold tracking-tight text-white">
                    {sensor.temperature !== null ? sensor.temperature.toFixed(1) : '--'}
                    <span className="text-xs font-normal text-slate-400 ml-0.5">°C</span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-slate-900/60 border border-slate-800/80 p-3.5 flex items-center gap-3 backdrop-blur-md">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                  isHighHumidity 
                    ? 'bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse' 
                    : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                }`}>
                  <Droplets className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">ความชื้นห้อง</div>
                  <div className={`text-xl font-bold tracking-tight ${isHighHumidity ? 'text-rose-400' : 'text-white'}`}>
                    {sensor.humidity !== null ? sensor.humidity.toFixed(1) : '--'}
                    <span className="text-xs font-normal text-slate-400 ml-0.5">%RH</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-900/40 border border-slate-800/50 text-[11px]">
              <span className="text-slate-400">ประเมินสภาพอากาศ:</span>
              {sensor.temperature === null ? (
                <span className="text-slate-500">รอรับสัญญาณสดจาก DHT22...</span>
              ) : isOptimal ? (
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> สบายผิว & ทางเดินหายใจโล่ง
                </span>
              ) : isHighHumidity ? (
                <span className="text-rose-400 font-semibold">ชื้นสูงเกินเกณฑ์ เสี่ยงไรฝุ่นสะสม</span>
              ) : (sensor.humidity ?? 0) < 50 ? (
                <span className="text-amber-400 font-semibold">อากาศแห้ง เสี่ยงผิวแห้งคัน</span>
              ) : (
                <span className="text-slate-400 font-medium">กำลังปรับสมดุลอากาศ</span>
              )}
            </div>
          </div>

          {/* Central Climate Ring */}
          <div className="relative flex flex-col items-center justify-center my-auto py-2">
            <div className={`absolute h-56 w-56 rounded-full blur-3xl transition-opacity duration-700 pointer-events-none ${
              !acState.power 
                ? 'bg-transparent' 
                : isDry 
                  ? 'bg-blue-600/20' 
                  : 'bg-cyan-500/25'
            }`} />

            <div className="relative flex h-56 w-56 items-center justify-center rounded-full border border-slate-800/90 bg-slate-950/70 p-4 shadow-[inset_0_2px_12px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
              <div className={`flex h-full w-full flex-col items-center justify-center rounded-full border transition-all duration-500 ${
                !acState.power 
                  ? 'border-slate-800/60 bg-slate-900/30 text-slate-600' 
                  : isDry
                    ? 'border-blue-500/40 bg-gradient-to-b from-blue-950/40 to-slate-950 text-blue-300 shadow-[0_0_30px_rgba(59,130,246,0.2)]'
                    : 'border-cyan-500/40 bg-gradient-to-b from-cyan-950/40 to-slate-950 text-cyan-300 shadow-[0_0_30px_rgba(6,182,212,0.2)]'
              }`}>
                {acState.power ? (
                  <>
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">
                      {isDry ? <Droplets className="h-3.5 w-3.5 text-blue-400" /> : <Snowflake className="h-3.5 w-3.5 text-cyan-400" />}
                      {isDry ? 'Dry Mode' : 'Cooling'}
                    </div>
                    
                    <div className="flex items-baseline justify-center">
                      <span className="text-6xl font-extrabold tracking-tighter text-white">
                        {isDry ? '--' : acState.target_temp}
                      </span>
                      {!isDry && <span className="text-2xl font-light text-slate-400 ml-1">°C</span>}
                    </div>

                    <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-400 bg-slate-900/80 px-2.5 py-1 rounded-full border border-slate-800">
                      <Wind className="h-3 w-3 text-cyan-400" />
                      <span>Fixed Low Fan</span>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center text-slate-500">
                    <Power className="h-10 w-10 mb-2 stroke-[1.5]" />
                    <span className="text-sm font-semibold tracking-wider uppercase">System OFF</span>
                  </div>
                )}
              </div>
            </div>

            {acState.power && (
              <div className="mt-3 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/80 border border-slate-800 text-xs text-slate-300">
                <Moon className="h-3.5 w-3.5 text-cyan-400" />
                <span>เข้าห้องนอนแล้ว: <strong>{inBedDurationMins} นาที</strong></span>
                {inBedDurationMins >= MIN_SLEEP_THRESHOLD_MINS ? (
                  <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    บันทึกการนอนจริง
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                    ช่วงวอร์ม (15 น.)
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Controls พร้อมปลดล็อกปุ่ม Chill/Safe ทุกสภาวะ */}
          <div className="space-y-2.5">
            <div className="grid grid-cols-4 gap-2">
              <button
                disabled={loading || !acState.power || acState.target_temp <= 18}
                onClick={() => updateState({ target_temp: Math.max(18, acState.target_temp - 1), mode: 'cool' })}
                className="py-3 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-30 active:scale-95"
              >
                <ChevronDown className="h-5 w-5" />
              </button>

              {/* 25°C Chill: กดได้ตลอดเวลา แม้จะอยู่ในโหมด Dry อยู่ */}
              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ target_temp: 25, mode: 'cool' })}
                className={`py-3 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && isCool && acState.target_temp === 25
                    ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30'
                }`}
              >
                <SunDim className="h-3.5 w-3.5" />
                25°C Chill
              </button>

              {/* 26°C Safe: กดได้ตลอดเวลาเพื่อรีเซ็ตกลับจุดประหยัด */}
              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ target_temp: 26, mode: 'cool' })}
                className={`py-3 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && isCool && acState.target_temp === 26
                    ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                26°C Safe
              </button>

              <button
                disabled={loading || !acState.power || acState.target_temp >= 30}
                onClick={() => updateState({ target_temp: Math.min(30, acState.target_temp + 1), mode: 'cool' })}
                className="py-3 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-30 active:scale-95"
              >
                <ChevronUp className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ mode: 'cool' })}
                className={`py-3 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                  isCool
                    ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400 disabled:opacity-30'
                }`}
              >
                <Snowflake className="h-4 w-4" />
                Cool
              </button>

              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ mode: 'dry' })}
                className={`py-3 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                  isDry
                    ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400 disabled:opacity-30'
                }`}
              >
                <Droplets className="h-4 w-4" />
                Dry (ลดชื้น)
              </button>

              <button
                disabled={loading}
                onClick={() => updateState({ power: !acState.power })}
                className={`py-3 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                  acState.power
                    ? 'bg-rose-500/20 border-rose-500/50 text-rose-400 shadow-[0_0_14px_rgba(244,63,94,0.2)]'
                    : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <Power className="h-4 w-4" />
                {acState.power ? 'Turn OFF' : 'Turn ON'}
              </button>
            </div>

            <div className="rounded-xl bg-slate-950 border border-slate-900 px-3.5 py-1.5 flex items-center justify-between text-[10px] text-slate-400 font-mono">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
                <span>IR: {acState.last_command_code}</span>
              </div>
              <span>LG 28-bit Protocol</span>
            </div>
          </div>
        </div>
      )}

      {/* ======================= TAB 2: กราฟ & วิเคราะห์ระบบ (ANALYTICS & LOGS) ======================= */}
      {currentTab === 'analytics' && (
        <div className="w-full max-w-md flex-1 space-y-4 py-1 overflow-y-auto pr-0.5 animate-fadeIn">
          {/* Header Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-cyan-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300">ประวัติสภาพอากาศจริง</span>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={logRange}
                onChange={(e) => setLogRange(Number(e.target.value))}
                className="bg-slate-900 text-slate-300 text-[11px] rounded-lg px-2 py-1 border border-slate-800 focus:outline-none"
              >
                <option value={30}>30 นาทีล่าสุด</option>
                <option value={60}>1 ชม. ล่าสุด</option>
                <option value={180}>3 ชม. ล่าสุด</option>
                <option value={360}>6 ชม. ล่าสุด</option>
              </select>

              <button
                onClick={fetchAnalyticsData}
                disabled={refreshing}
                className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white active:scale-95"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-cyan-400' : ''}`} />
              </button>
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-2.5 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">ESP32 Status</div>
              <div className="mt-1 flex items-center justify-center gap-1.5">
                {stats.lastSeenMins !== null ? (
                  <>
                    <span className={`h-2 w-2 rounded-full ${stats.lastSeenMins <= 3 ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
                    <span className="text-xs font-bold text-slate-200">
                      {stats.lastSeenMins <= 3 ? 'Online' : `${stats.lastSeenMins}น. ที่แล้ว`}
                    </span>
                  </>
                ) : (
                  <span className="text-xs font-medium text-slate-500">รอเชื่อมต่อ</span>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-2.5 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">ช่วงอุณหภูมิ</div>
              <div className="mt-1 text-xs font-bold text-amber-400">
                {stats.minT !== null ? `${stats.minT} - ${stats.maxT}°C` : '--'}
              </div>
            </div>

            <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-2.5 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Healthy Zone</div>
              <div className="mt-1 text-xs font-bold text-emerald-400">
                {historyLogs.length > 0 ? `${stats.optimalPercent}%` : '--'}
              </div>
            </div>
          </div>

          {/* Horizontal Scrollable Interactive Chart */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-3.5 backdrop-blur-xl">
            <div className="flex items-center justify-between mb-2 text-[11px]">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-amber-400 font-semibold">
                  <span className="h-2 w-2 rounded-full bg-amber-400" /> อุณหภูมิ (°C)
                </span>
                <span className="flex items-center gap-1 text-cyan-400 font-semibold">
                  <span className="h-2 w-2 rounded-full bg-cyan-400" /> ความชื้น (%RH)
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">เลื่อนซ้าย-ขวาเพื่อดูไทม์ไลน์ ➔</span>
            </div>

            <div 
              ref={chartScrollRef}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              className="relative w-full h-52 bg-slate-950/70 rounded-xl overflow-x-auto overflow-y-hidden border border-slate-900 scrollbar-thin scrollbar-thumb-slate-800"
            >
              {chartData ? (
                <div style={{ width: `${chartData.width}px` }} className="h-full relative">
                  <svg 
                    viewBox={`0 0 ${chartData.width} ${chartData.height}`} 
                    className="w-full h-full block"
                  >
                    {/* แถบ Healthy Humidity Zone (50 - 58 %RH) */}
                    <rect
                      x="0"
                      y={chartData.getYH(58)}
                      width={chartData.width}
                      height={chartData.getYH(50) - chartData.getYH(58)}
                      fill="rgba(16, 185, 129, 0.08)"
                    />
                    
                    {/* เส้นเตือนชื้นสูงวิกฤต (62 %RH) */}
                    <line
                      x1="0"
                      y1={chartData.getYH(62)}
                      x2={chartData.width}
                      y2={chartData.getYH(62)}
                      stroke="rgba(244, 63, 94, 0.4)"
                      strokeDasharray="4 4"
                      strokeWidth="1"
                    />

                    {/* เส้นกราฟความชื้น (%RH) */}
                    <path
                      d={chartData.humPath}
                      fill="none"
                      stroke="#06b6d4"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />

                    {/* เส้นกราฟอุณหภูมิ (°C) */}
                    <path
                      d={chartData.tempPath}
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />

                    {/* จุดบนกราฟและแกนเวลา */}
                    {chartData.dots.map((d, i) => (
                      <g key={i} className="cursor-pointer" onClick={() => setHoveredPoint(d.log)}>
                        {i % 5 === 0 && (
                          <text
                            x={d.x}
                            y={chartData.height - 8}
                            fill="#64748b"
                            fontSize="9"
                            fontFamily="monospace"
                            textAnchor="middle"
                          >
                            {new Date(d.log.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                          </text>
                        )}

                        {d.log.ac_mode === 'dry' && (
                          <circle cx={d.x} cy={d.yh} r="4.5" fill="#3b82f6" stroke="#ffffff" strokeWidth="1.5" />
                        )}

                        <circle
                          cx={d.x}
                          cy={d.yt}
                          r={hoveredPoint?.id === d.log.id ? "5.5" : "2.5"}
                          fill="#f59e0b"
                        />
                      </g>
                    ))}
                  </svg>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  รอรับข้อมูลจาก ESP32 อย่างน้อย 2 บันทึก...
                </div>
              )}
            </div>

            {/* Tooltip เมื่อแตะจุดกราฟ */}
            {hoveredPoint ? (
              <div className="mt-2.5 rounded-xl bg-slate-950 p-2.5 border border-slate-800 flex items-center justify-between text-xs animate-fadeIn">
                <div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    เวลา: {new Date(hoveredPoint.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    แอร์โหมด: <span className="uppercase text-cyan-400">{hoveredPoint.ac_mode || 'Cool'}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-amber-400 font-bold">{hoveredPoint.temperature}°C</div>
                  <div className="text-cyan-400 font-bold">{hoveredPoint.humidity}%RH</div>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-center text-[10px] text-slate-500">ปัดซ้าย-ขวา แล้วแตะที่จุดบนกราฟเพื่อดูเวลาที่เกิดเหตุการณ์</p>
            )}
          </div>

          {/* Timeline เซสชันการนอนจริง */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-3.5 backdrop-blur-xl">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-4 w-4 text-cyan-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">ไทม์ไลน์เซสชันการนอนจริง</h3>
            </div>

            {sleepSessions.length > 0 ? (
              <div className="space-y-3 relative before:absolute before:inset-0 before:left-3 before:w-0.5 before:bg-slate-800">
                {sleepSessions.map((s, idx) => (
                  <div key={idx} className="relative flex items-start gap-3 pl-1">
                    <span className="h-4 w-4 rounded-full bg-indigo-500/20 border border-indigo-400 flex items-center justify-center mt-0.5 z-10">
                      <Moon className="h-2.5 w-2.5 text-indigo-400" />
                    </span>
                    <div className="flex-1 text-xs bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80">
                      <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono mb-1">
                        <span>{new Date(s.started_at).toLocaleDateString('th-TH')}</span>
                        <span>{Math.floor((s.duration_minutes || 0) / 60)} ชม. {(s.duration_minutes || 0) % 60} น.</span>
                      </div>
                      <div className="font-semibold text-indigo-300">
                        {new Date(s.started_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} - {s.ended_at ? new Date(s.ended_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : 'กำลังนอน'}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                        <span>เฉลี่ย: {s.avg_temp}°C • {s.avg_humidity}%RH</span>
                        {s.dry_mode_count ? (
                          <span className="text-blue-400 text-[10px]">ตัด Dry {s.dry_mode_count} ครั้ง</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-slate-500">
                ยังไม่มีประวัติการนอนที่บันทึก (ระบบจะบันทึกเมื่อเปิดแอร์ต่อเนื่องเกิน 15 นาที)
              </div>
            )}
          </div>
        </div>
      )}

      {/* ======================= BOTTOM NAVIGATION DOCK ======================= */}
      <nav className="fixed bottom-3 w-[calc(100%-2rem)] max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-1.5 backdrop-blur-xl shadow-2xl flex items-center justify-around z-50">
        <button
          onClick={() => setCurrentTab('control')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition active:scale-95 ${
            currentTab === 'control'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Sliders className="h-4 w-4" />
          <span>ควบคุมแอร์</span>
        </button>

        <button
          onClick={() => {
            setCurrentTab('analytics');
            fetchAnalyticsData();
          }}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition active:scale-95 ${
            currentTab === 'analytics'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <ChartIcon className="h-4 w-4" />
          <span>กราฟ & ไทม์ไลน์</span>
        </button>
      </nav>
    </div>
  );
}