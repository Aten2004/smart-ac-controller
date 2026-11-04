import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { 
  Power, Droplets, Thermometer, ShieldCheck, 
  Lock, Wind, Snowflake, SunDim, Sparkles, 
  Moon, Clock, ChevronUp, ChevronDown, CheckCircle2
} from 'lucide-react';

interface ACState {
  id: number;
  power: boolean;
  mode: 'cool' | 'dry' | 'off';
  target_temp: number;
  fan_speed: string;
  is_auto: boolean;
  last_command_code: string;
}

interface SensorData {
  temperature: number;
  humidity: number;
}

interface SleepSession {
  started_at: string;
  ended_at?: string;
  duration_minutes?: number;
  avg_temp?: number;
  avg_humidity?: number;
  dry_mode_count?: number;
}

const PIN_KEY = 'app_pin_unlocked';
const SYSTEM_PIN = '1234';
const SESSION_START_KEY = 'ac_sleep_session_start';
const MIN_SLEEP_THRESHOLD_MINS = 15; // เปิดเกิน 15 นาทีถือว่าเป็นการนอนจริง

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [acState, setAcState] = useState<ACState>({
    id: 1,
    power: false,
    mode: 'cool',
    target_temp: 26,
    fan_speed: 'low',
    is_auto: true,
    last_command_code: '0x88C0051'
  });
  const [sensor, setSensor] = useState<SensorData>({ temperature: 25.8, humidity: 56.4 });
  const [loading, setLoading] = useState<boolean>(false);
  
  // สถานะเกี่ยวกับการนอน
  const [sessionStartTime, setSessionStartTime] = useState<string | null>(null);
  const [inBedDurationMins, setInBedDurationMins] = useState<number>(0);
  const [lastSession, setLastSession] = useState<SleepSession | null>(null);

  useEffect(() => {
    if (localStorage.getItem(PIN_KEY) === 'true') {
      setIsAuthenticated(true);
    }
    const savedStart = localStorage.getItem(SESSION_START_KEY);
    if (savedStart) {
      setSessionStartTime(savedStart);
    }
  }, []);

  // ตัวนับเวลาขณะอยู่ในห้องนอน
  useEffect(() => {
    if (!acState.power || !sessionStartTime) {
      setInBedDurationMins(0);
      return;
    }

    const updateDuration = () => {
      const diffMs = new Date().getTime() - new Date(sessionStartTime).getTime();
      setInBedDurationMins(Math.floor(diffMs / (1000 * 60)));
    };

    updateDuration();
    const interval = setInterval(updateDuration, 30000); // อัปเดตทุก 30 วินาที
    return () => clearInterval(interval);
  }, [acState.power, sessionStartTime]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchData = async () => {
      const { data: ac } = await supabase.from('ac_control').select('*').eq('id', 1).single();
      if (ac) setAcState(ac);

      const { data: logs } = await supabase
        .from('sensor_logs')
        .select('temperature, humidity')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (logs) setSensor(logs);

      // ดึงสถิติการนอนรอบล่าสุด
      const { data: lastSleep } = await supabase
        .from('sleep_sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .single();
      if (lastSleep) setLastSession(lastSleep);
    };

    fetchData();

    const acChannel = supabase
      .channel('realtime_ac_control')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ac_control' }, (payload) => {
        setAcState(payload.new as ACState);
      })
      .subscribe();

    const sensorChannel = supabase
      .channel('realtime_sensor_logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_logs' }, (payload) => {
        setSensor({
          temperature: payload.new.temperature,
          humidity: payload.new.humidity
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(acChannel);
      supabase.removeChannel(sensorChannel);
    };
  }, [isAuthenticated]);

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

  // ฟังก์ชันคำนวณและบันทึกประวัติการนอนเมื่อปิดแอร์
  const handleSleepSessionEnd = async (startTimeStr: string) => {
    const endTime = new Date();
    const startTime = new Date(startTimeStr);
    const durationMins = Math.floor((endTime.getTime() - startTime.getTime()) / (1000 * 60));

    // หากเปิดไม่ถึง 15 นาที ถือเป็นการทดสอบ ไม่บันทึก
    if (durationMins < MIN_SLEEP_THRESHOLD_MINS) {
      console.log(`[SESSION] เปิดเพียง ${durationMins} นาที (ต่ำกว่าเกณฑ์ ${MIN_SLEEP_THRESHOLD_MINS} นาที) - ข้ามการบันทึก`);
      localStorage.removeItem(SESSION_START_KEY);
      setSessionStartTime(null);
      return;
    }

    // ดึงค่า Log อุณหภูมิและความชื้นในช่วงเวลาที่นอน
    const { data: logs } = await supabase
      .from('sensor_logs')
      .select('temperature, humidity')
      .gte('created_at', startTime.toISOString())
      .lte('created_at', endTime.toISOString());

    let avgT = sensor.temperature;
    let avgH = sensor.humidity;

    if (logs && logs.length > 0) {
      const sumT = logs.reduce((acc, curr) => acc + Number(curr.temperature), 0);
      const sumH = logs.reduce((acc, curr) => acc + Number(curr.humidity), 0);
      avgT = Number((sumT / logs.length).toFixed(1));
      avgH = Number((sumH / logs.length).toFixed(1));
    }

    const newSession = {
      started_at: startTime.toISOString(),
      ended_at: endTime.toISOString(),
      duration_minutes: durationMins,
      avg_temp: avgT,
      avg_humidity: avgH
    };

    const { data, error } = await supabase.from('sleep_sessions').insert([newSession]).select().single();
    if (!error && data) {
      setLastSession(data);
    }

    localStorage.removeItem(SESSION_START_KEY);
    setSessionStartTime(null);
  };

  const updateState = async (updates: Partial<ACState>) => {
    setLoading(true);
    const nextPower = updates.power !== undefined ? updates.power : acState.power;
    const nextMode = updates.mode !== undefined ? updates.mode : acState.mode;
    const nextTemp = updates.target_temp !== undefined ? updates.target_temp : acState.target_temp;

    // ตรวจสอบโฟลว์การเปิด/ปิดเพื่อจัดการ Sleep Session
    if (updates.power !== undefined) {
      if (updates.power && !acState.power) {
        // เริ่มต้นเปิดแอร์ -> บันทึกเวลาเริ่มเข้าห้องนอน
        const nowIso = new Date().toISOString();
        localStorage.setItem(SESSION_START_KEY, nowIso);
        setSessionStartTime(nowIso);
      } else if (!updates.power && acState.power) {
        // ปิดแอร์ -> เข้ากระบวนการตรวจสอบและสรุปผลการนอน
        const currentStart = sessionStartTime || localStorage.getItem(SESSION_START_KEY);
        if (currentStart) {
          await handleSleepSessionEnd(currentStart);
        }
      }
    }

    let hexCode = '0x88C0051';
    if (nextPower) {
      if (nextMode === 'dry') {
        hexCode = '0x880194E';
      } else if (nextTemp === 25) {
        hexCode = '0x8800A4E';
      } else {
        hexCode = '0x8800B4F';
      }
    }

    const payload = { ...updates, last_command_code: hexCode };
    setAcState((prev) => ({ ...prev, ...payload }));

    const { error } = await supabase.from('ac_control').update(payload).eq('id', 1);
    setLoading(false);
    if (error) console.error(error);
  };

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#070b14] px-6 text-white font-sans">
        <form onSubmit={handlePinSubmit} className="w-full max-w-xs rounded-3xl bg-slate-900/80 p-8 text-center border border-slate-800 shadow-2xl backdrop-blur-xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Lock className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100">Climate Gate</h2>
          <p className="mt-1 mb-6 text-xs text-slate-400">ระบุรหัส 4 หลักเพื่อควบคุมอุปกรณ์</p>
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

  const isDry = acState.power && acState.mode === 'dry';
  const isCool = acState.power && acState.mode === 'cool';
  const isHighHumidity = sensor.humidity >= 62.0;
  const isOptimal = sensor.humidity >= 50 && sensor.humidity <= 58 && sensor.temperature >= 25.0 && sensor.temperature <= 26.5;

  return (
    <div className="min-h-[100dvh] bg-[#070b14] text-slate-100 flex flex-col items-center justify-between p-5 pb-6 font-sans select-none antialiased">
      {/* 1. Header Bar */}
      <header className="w-full max-w-md flex items-center justify-between pt-1 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight text-white">LG Climate Hub</h1>
            <span className="flex h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse" />
          </div>
          <p className="text-[11px] font-medium text-slate-400 tracking-wide">ห้องนอน 7.7 m² • S13LCN</p>
        </div>

        <button 
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

      {/* 2. Room Sensor Badges & Comfort Status */}
      <div className="w-full max-w-md space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-slate-900/60 border border-slate-800/80 p-3.5 flex items-center gap-3 backdrop-blur-md">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Thermometer className="h-5 w-5" />
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">อุณหภูมิห้อง</div>
              <div className="text-xl font-bold tracking-tight text-white">
                {sensor.temperature > 0 ? Number(sensor.temperature).toFixed(1) : '--'}
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
                {sensor.humidity > 0 ? Number(sensor.humidity).toFixed(1) : '--'}
                <span className="text-xs font-normal text-slate-400 ml-0.5">%RH</span>
              </div>
            </div>
          </div>
        </div>

        {/* ป้ายเตือนสภาวะอากาศเพื่อผิวหนังและภูมิแพ้ */}
        <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-900/40 border border-slate-800/50 text-[11px]">
          <span className="text-slate-400">ประเมินสภาพอากาศ:</span>
          {isOptimal ? (
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> สบายผิว & ทางเดินหายใจโล่ง
            </span>
          ) : isHighHumidity ? (
            <span className="text-rose-400 font-semibold">ชื้นสูงเกินเกณฑ์ เสี่ยงไรฝุ่นสะสม</span>
          ) : sensor.humidity < 50 ? (
            <span className="text-amber-400 font-semibold">อากาศแห้ง เสี่ยงผิวแห้งคัน</span>
          ) : (
            <span className="text-slate-400 font-medium">กำลังปรับสมดุลอากาศ</span>
          )}
        </div>
      </div>

      {/* 3. Central Climate Ring & Live Session Tracker */}
      <div className="relative flex flex-col items-center justify-center my-auto py-2">
        {/* Glowing Background Radial */}
        <div className={`absolute h-60 w-60 rounded-full blur-3xl transition-opacity duration-700 pointer-events-none ${
          !acState.power 
            ? 'bg-transparent' 
            : isDry 
              ? 'bg-blue-600/20' 
              : 'bg-cyan-500/25'
        }`} />

        {/* Outer Circular Track */}
        <div className="relative flex h-60 w-60 items-center justify-center rounded-full border border-slate-800/90 bg-slate-950/70 p-4 shadow-[inset_0_2px_12px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
          {/* Inner Halo Ring */}
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

        {/* ตัวนับเวลาการเข้านอนแบบสด (Active Sleep Timer) */}
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

      {/* 4. Thumb-Zone Controls & Sleep Statistics */}
      <div className="w-full max-w-md space-y-2.5">
        {/* ปรับอุณหภูมิละเอียด (+ / -) และ Presets */}
        <div className="grid grid-cols-4 gap-2">
          <button
            disabled={loading || !acState.power || isDry || acState.target_temp <= 24}
            onClick={() => updateState({ target_temp: acState.target_temp - 1, mode: 'cool' })}
            className="py-3 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-30 active:scale-95"
          >
            <ChevronDown className="h-5 w-5" />
          </button>

          <button
            disabled={loading || !acState.power || isDry}
            onClick={() => updateState({ target_temp: 25, mode: 'cool' })}
            className={`py-3 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
              acState.power && isCool && acState.target_temp === 25
                ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                : 'bg-slate-900/70 border-slate-800 text-slate-400 disabled:opacity-30'
            }`}
          >
            <SunDim className="h-3.5 w-3.5" />
            25°C Chill
          </button>

          <button
            disabled={loading || !acState.power || isDry}
            onClick={() => updateState({ target_temp: 26, mode: 'cool' })}
            className={`py-3 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
              acState.power && isCool && acState.target_temp === 26
                ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                : 'bg-slate-900/70 border-slate-800 text-slate-400 disabled:opacity-30'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            26°C Safe
          </button>

          <button
            disabled={loading || !acState.power || isDry || acState.target_temp >= 28}
            onClick={() => updateState({ target_temp: acState.target_temp + 1, mode: 'cool' })}
            className="py-3 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-30 active:scale-95"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
        </div>

        {/* ปุ่มโหมดการทำงานและ Power หลัก */}
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

        {/* การ์ดสถิติการนอนรอบล่าสุด (Last Sleep Summary) */}
        {lastSession && (
          <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-3 flex items-center justify-between text-xs backdrop-blur-md">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Clock className="h-4 w-4" />
              </div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase font-semibold">การนอนครั้งล่าสุด</div>
                <div className="font-medium text-slate-200">
                  {Math.floor((lastSession.duration_minutes || 0) / 60)} ชม. {(lastSession.duration_minutes || 0) % 60} นาที
                </div>
              </div>
            </div>

            <div className="text-right">
              <div className="text-[10px] text-slate-400">เฉลี่ยตลอดคืน</div>
              <div className="font-medium text-cyan-400">
                {lastSession.avg_temp}°C • {lastSession.avg_humidity}%RH
              </div>
            </div>
          </div>
        )}

        {/* Hardware Status Strip */}
        <div className="rounded-xl bg-slate-950 border border-slate-900 px-3.5 py-1.5 flex items-center justify-between text-[10px] text-slate-400 font-mono">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
            <span>IR: {acState.last_command_code}</span>
          </div>
          <span>LG 28-bit Protocol</span>
        </div>
      </div>
    </div>
  );
}