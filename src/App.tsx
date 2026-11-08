import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from './supabaseClient';
import { 
  Power, Droplets, Thermometer, ShieldCheck, 
  Lock, Wind, Snowflake, SunDim, Sparkles, 
  Moon, Clock, ChevronUp, ChevronDown, 
  Sliders, Activity, 
  Loader2, Copy, Check, Timer as TimerIcon, Trash2, 
  Table as TableIcon, Calendar, Smartphone, 
  BarChart2, X
} from 'lucide-react';

interface ACState {
  id: number;
  power: boolean;
  mode: 'cool' | 'dry' | 'off' | 'deep_cool';
  target_temp: number;
  fan_speed: string;
  is_auto: boolean;
  last_command_code: string;
  is_sleeping?: boolean;
  sleep_started_at?: string | null;
  session_started_at?: string | null;
  updated_at?: string;
  timer_target_at?: string | null;
  timer_action?: 'turn_off' | 'turn_on_cool25' | null;
  schedule_enabled?: boolean;
  schedule_start?: string;
  schedule_end?: string;
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
  screen_checks?: number;
}

const PIN_KEY = 'app_pin_unlocked';
const SYSTEM_PIN = '1234';
const MIN_SLEEP_THRESHOLD_MINS = 60;
const SLEEP_GOAL_MINS = 480; // 8 ชม.

const calculateLgHex = (power: boolean, mode: string, temp: number, fanSpeed: string = 'low'): string => {
  if (!power) return '0x88C0051';
  if (mode === 'dry') return '0x880194E';
  
  const clamped = Math.min(Math.max(temp, 18), 30);
  const tempNibble = clamped - 15;
  
  let fanNibble = 4; // low
  if (fanSpeed === 'med') fanNibble = 2;
  else if (fanSpeed === 'high') fanNibble = 0;
  
  const checksum = (8 + 8 + 0 + 0 + tempNibble + fanNibble) & 0x0F;
  return `0x8800${tempNibble.toString(16).toUpperCase()}${fanNibble}${checksum.toString(16).toUpperCase()}`;
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [currentTab, setCurrentTab] = useState<'remote' | 'sleep'>('remote');
  const [loading, setLoading] = useState<boolean>(false);

  const [acState, setAcState] = useState<ACState | null>(null);
  const [sensor, setSensor] = useState<{ temperature: number | null; humidity: number | null }>({ 
    temperature: null, 
    humidity: null 
  });
  
  const [inBedDurationMins, setInBedDurationMins] = useState<number>(0);
  const [historyLogs, setHistoryLogs] = useState<SensorLog[]>([]);
  const [sleepSessions, setSleepSessions] = useState<SleepSession[]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<SensorLog | null>(null);
  const [logRange, setLogRange] = useState<number>(60);
  const [containerWidth, setContainerWidth] = useState<number>(360);

  // Filters for Sensor Logs Table
  const [sensorFilterMode, setSensorFilterMode] = useState<string>('all');
  const [sensorFilterDate, setSensorFilterDate] = useState<string>('');
  const [isHistoricalView, setIsHistoricalView] = useState<boolean>(false);

  // Filters for Sleep Sessions
  const [sleepFilterType, setSleepFilterType] = useState<string>('all');
  const [sleepFilterDate, setSleepFilterDate] = useState<string>('');

  const [showTimerCard, setShowTimerCard] = useState<boolean>(false);
  const [timerSubTab, setTimerSubTab] = useState<'countdown' | 'schedule'>('countdown');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [customTimerMinutes, setCustomTimerMinutes] = useState<string>('30');

  const isTimerProcessingRef = useRef<boolean>(false);
  const lastScheduleOnKeyRef = useRef<string>('');
  const lastScheduleOffKeyRef = useRef<string>('');

  const [copiedData, setCopiedData] = useState<boolean>(false);
  const [showRawTable, setShowRawTable] = useState<boolean>(false);

  const manualOverrideLockUntil = useRef<number>(0);
  const chartScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (localStorage.getItem(PIN_KEY) === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  // วัดขนาดความกว้าง Container ของกราฟเพื่อคำนวณสัดส่วนแบบ Responsive
  useEffect(() => {
    if (chartScrollRef.current) {
      setContainerWidth(chartScrollRef.current.clientWidth);
    }
    const handleResize = () => {
      if (chartScrollRef.current) {
        setContainerWidth(chartScrollRef.current.clientWidth);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // รีเซ็ตจุดที่เลือกกลับไปเป็นจุดล่าสุดเมื่อเปลี่ยนตัวกรอง
  useEffect(() => {
    setHoveredPoint(null);
  }, [logRange, sensorFilterDate, sensorFilterMode]);

  const formatHoursMins = (totalMins: number) => {
    if (totalMins <= 0) return '0 นาที';
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours === 0) return `${mins} นาที`;
    return mins > 0 ? `${hours} ชม. ${mins} น.` : `${hours} ชม.`;
  };

  // Realtime Polling & Reconnect Engine (Auto-Wake)
  const fetchControlStateOnly = async () => {
    try {
      const { data: ac } = await supabase.from('ac_control').select('*').eq('id', 1).single();
      if (ac && Date.now() >= manualOverrideLockUntil.current) {
        setAcState(ac);
      }
    } catch (err) {
      console.error('Fetch control error:', err);
    }
  };

  const fetchAnalyticsData = async (targetDate?: string) => {
    setRefreshing(true);
    try {
      if (targetDate) {
        const [y, m, d] = targetDate.split('-').map(Number);
        const start = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
        const end = new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();

        const { data: logs, error: logsErr } = await supabase
          .from('sensor_logs')
          .select('*')
          .gte('created_at', start)
          .lte('created_at', end)
          .order('created_at', { ascending: true })
          .limit(1440);

        if (!logsErr && logs) {
          const parsedLogs: SensorLog[] = logs.map(l => ({
            ...l,
            temperature: Number(l.temperature),
            humidity: Number(l.humidity)
          }));
          setHistoryLogs(parsedLogs);
          setIsHistoricalView(true);
          if (parsedLogs.length > 0) {
            const last = parsedLogs[parsedLogs.length - 1];
            setSensor({ temperature: last.temperature, humidity: last.humidity });
          }
        }
      } else {
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
          setHistoryLogs([...parsedLogs].reverse());
          setIsHistoricalView(false);
          const latest = parsedLogs[0];
          setSensor({ temperature: latest.temperature, humidity: latest.humidity });
        }
      }

      const { data: sessions, error: sessErr } = await supabase
        .from('sleep_sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50);

      if (!sessErr && sessions) {
        setSleepSessions(sessions);
      }
    } catch (err) {
      console.error('Fetch analytics error:', err);
    }
  };

  const fetchInitial = async () => {
    await fetchControlStateOnly();
    await fetchAnalyticsData(sensorFilterDate || undefined);
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchInitial();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchInitial();
      }
    };

    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);

    const fallbackPoll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchControlStateOnly();
      }
    }, 3500);

    const acChannel = supabase
      .channel('realtime_ac_control')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ac_control' }, (payload) => {
        if (Date.now() < manualOverrideLockUntil.current) return;
        if (payload.new && (payload.new as ACState).id === 1) {
          setAcState(payload.new as ACState);
        }
      })
      .subscribe();

    const sensorChannel = supabase
      .channel('realtime_sensor_logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_logs' }, (payload) => {
        const rawLog = payload.new as SensorLog;
        const newLog: SensorLog = {
          ...rawLog,
          temperature: Number(rawLog.temperature),
          humidity: Number(rawLog.humidity)
        };
        setSensor({ temperature: newLog.temperature, humidity: newLog.humidity });
        if (!sensorFilterDate) {
          setHistoryLogs((prev) => {
            const next = [...prev, newLog];
            return next.length > logRange ? next.slice(next.length - logRange) : next;
          });
        }
      })
      .subscribe();

    return () => {
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(fallbackPoll);
      supabase.removeChannel(acChannel);
      supabase.removeChannel(sensorChannel);
    };
  }, [isAuthenticated, logRange, sensorFilterDate]);

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

  useEffect(() => {
    if (!acState?.timer_target_at || !acState?.timer_action) {
      setRemainingSeconds(0);
      isTimerProcessingRef.current = false;
      return;
    }

    const targetMs = new Date(acState.timer_target_at).getTime();
    const checkTimer = async () => {
      const diffMs = targetMs - Date.now();
      if (diffMs <= 0) {
        if (isTimerProcessingRef.current) return;
        isTimerProcessingRef.current = true;
        const action = acState.timer_action;
        setRemainingSeconds(0);
        setAcState(prev => prev ? ({ ...prev, timer_target_at: null, timer_action: null }) : null);

        await supabase.from('ac_control').update({
          timer_target_at: null,
          timer_action: null
        }).eq('id', 1);

        if (diffMs > -120000) {
          if (action === 'turn_off') {
            await updateState({ power: false, timer_target_at: null, timer_action: null });
          } else if (action === 'turn_on_cool25') {
            await updateState({ 
              power: true, 
              mode: 'cool', 
              target_temp: 25, 
              is_auto: true, 
              timer_target_at: null, 
              timer_action: null 
            });
          }
        }
        isTimerProcessingRef.current = false;
      } else {
        setRemainingSeconds(Math.ceil(diffMs / 1000));
      }
    };
    checkTimer();
    const timerInterval = setInterval(checkTimer, 1000);
    return () => clearInterval(timerInterval);
  }, [acState?.timer_target_at, acState?.timer_action]);

  useEffect(() => {
    if (!acState?.schedule_enabled) {
      lastScheduleOnKeyRef.current = '';
      lastScheduleOffKeyRef.current = '';
      return;
    }

    const checkSchedule = async () => {
      if (!acState?.schedule_enabled) return;

      const now = new Date();
      const curH = now.getHours();
      const curM = now.getMinutes();
      const curMins = curH * 60 + curM;
      const todayDate = now.toDateString();

      const [startH, startM] = (acState.schedule_start || '20:00').split(':').map(Number);
      const [endH, endM] = (acState.schedule_end || '10:00').split(':').map(Number);
      const startMins = startH * 60 + startM;
      const endMins = endH * 60 + endM;

      const onKey = `${todayDate}_${startH}:${startM}`;
      const offKey = `${todayDate}_${endH}:${endM}`;

      if (curMins === startMins && lastScheduleOnKeyRef.current !== onKey) {
        lastScheduleOnKeyRef.current = onKey;
        if (!acState.power) {
          await updateState({ power: true, mode: 'cool', target_temp: 25, is_auto: true });
        }
      } else if (curMins === endMins && lastScheduleOffKeyRef.current !== offKey) {
        lastScheduleOffKeyRef.current = offKey;
        if (acState.power) {
          await updateState({ power: false });
        }
      }
    };

    checkSchedule();
    const scheduleInterval = setInterval(checkSchedule, 3000);
    return () => clearInterval(scheduleInterval);
  }, [acState?.schedule_enabled, acState?.schedule_start, acState?.schedule_end, acState?.power]);

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

      let avgT = sensor.temperature ?? 25.0;
      let avgH = sensor.humidity ?? 58.0;
      let dryCount = 0;

      if (logs && logs.length > 0) {
        const validTemps = logs.map(l => Number(l.temperature)).filter(v => !isNaN(v));
        const validHums = logs.map(l => Number(l.humidity)).filter(v => !isNaN(v));
        if (validTemps.length > 0) avgT = Number((validTemps.reduce((a, b) => a + b, 0) / validTemps.length).toFixed(1));
        if (validHums.length > 0) avgH = Number((validHums.reduce((a, b) => a + b, 0) / validHums.length).toFixed(1));
        dryCount = logs.filter(l => l.ac_mode === 'deep_cool' || l.ac_mode === 'dry').length;
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

  const updateState = async (updates: Partial<ACState>) => {
    if (!acState) return;
    setLoading(true);
    manualOverrideLockUntil.current = Date.now() + 6000;

    const nextAuto = updates.is_auto !== undefined ? updates.is_auto : acState.is_auto;
    const nextPower = updates.power !== undefined ? updates.power : acState.power;
    const nextMode = updates.mode !== undefined ? updates.mode : acState.mode;
    const nextTemp = updates.target_temp !== undefined ? updates.target_temp : acState.target_temp;
    const nextFan = updates.fan_speed !== undefined ? updates.fan_speed : (acState.fan_speed || 'low');
    const nextHex = calculateLgHex(nextPower, nextMode, nextTemp, nextFan);

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
      fan_speed: nextFan,
      is_auto: nextAuto,
      last_command_code: nextHex,
      session_started_at: sessionStartedAt,
      updated_at: new Date().toISOString()
    };

    setAcState(prev => prev ? ({ ...prev, ...payload }) : null);
    try {
      await supabase.from('ac_control').update(payload).eq('id', 1);
    } catch (err) {
      console.error('Update failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleStartCountdown = async (mins: number) => {
    if (mins <= 0 || !acState) return;
    isTimerProcessingRef.current = false;
    const autoAction: 'turn_off' | 'turn_on_cool25' = acState.power ? 'turn_off' : 'turn_on_cool25';
    const targetIso = new Date(Date.now() + mins * 60 * 1000).toISOString();

    setAcState(prev => prev ? ({ ...prev, timer_target_at: targetIso, timer_action: autoAction }) : null);
    setShowTimerCard(false);

    await supabase.from('ac_control').update({
      timer_target_at: targetIso,
      timer_action: autoAction
    }).eq('id', 1);
  };

  const handleCancelCountdown = async () => {
    isTimerProcessingRef.current = false;
    setRemainingSeconds(0);
    setAcState(prev => prev ? ({ ...prev, timer_target_at: null, timer_action: null }) : null);

    await supabase.from('ac_control').update({
      timer_target_at: null,
      timer_action: null
    }).eq('id', 1);
  };

  const handleToggleSchedule = async () => {
    if (!acState) return;
    const newEnabled = !(acState.schedule_enabled ?? false);
    setAcState(prev => prev ? ({ ...prev, schedule_enabled: newEnabled }) : null);
    await supabase.from('ac_control').update({ schedule_enabled: newEnabled }).eq('id', 1);

    if (newEnabled) {
      lastScheduleOnKeyRef.current = '';
      lastScheduleOffKeyRef.current = '';

      const now = new Date();
      const curH = now.getHours();
      const curM = now.getMinutes();
      const curMins = curH * 60 + curM;
      const [startH, startM] = (acState.schedule_start || '20:00').split(':').map(Number);
      const [endH, endM] = (acState.schedule_end || '10:00').split(':').map(Number);
      const startMins = startH * 60 + startM;
      const endMins = endH * 60 + endM;

      let isInside = false;
      if (startMins < endMins) {
        isInside = curMins >= startMins && curMins < endMins;
      } else if (startMins > endMins) {
        isInside = curMins >= startMins || curMins < endMins;
      }

      if (isInside && !acState.power) {
        lastScheduleOnKeyRef.current = `${now.toDateString()}_${startH}:${startM}`;
        await updateState({ power: true, mode: 'cool', target_temp: 25, is_auto: true });
      }
    }
  };

  const handleSaveScheduleTimes = async (start: string, end: string) => {
    if (!acState) return;
    setAcState(prev => prev ? ({ ...prev, schedule_start: start, schedule_end: end }) : null);
    await supabase.from('ac_control').update({ schedule_start: start, schedule_end: end }).eq('id', 1);

    lastScheduleOnKeyRef.current = '';
    lastScheduleOffKeyRef.current = '';

    if (acState.schedule_enabled) {
      const now = new Date();
      const curH = now.getHours();
      const curM = now.getMinutes();
      const curMins = curH * 60 + curM;
      const [startH, startM] = start.split(':').map(Number);
      const [endH, endM] = end.split(':').map(Number);
      const startMins = startH * 60 + startM;
      const endMins = endH * 60 + endM;

      let isInside = false;
      if (startMins < endMins) {
        isInside = curMins >= startMins && curMins < endMins;
      } else if (startMins > endMins) {
        isInside = curMins >= startMins || curMins < endMins;
      }

      if (isInside && !acState.power) {
        lastScheduleOnKeyRef.current = `${now.toDateString()}_${startH}:${startM}`;
        await updateState({ power: true, mode: 'cool', target_temp: 25, is_auto: true });
      }
    }
  };

  const handleDateFilterChange = (dateVal: string) => {
    setSensorFilterDate(dateVal);
    fetchAnalyticsData(dateVal || undefined);
  };

  const stats = useMemo(() => {
    if (historyLogs.length === 0) {
      return { minT: null, maxT: null, avgT: null, minH: null, maxH: null, avgH: null, optimalPercent: 0 };
    }
    const temps = historyLogs.map(l => Number(l.temperature)).filter(v => !isNaN(v));
    const hums = historyLogs.map(l => Number(l.humidity)).filter(v => !isNaN(v));
    if (temps.length === 0 || hums.length === 0) {
      return { minT: null, maxT: null, avgT: null, minH: null, maxH: null, avgH: null, optimalPercent: 0 };
    }
    const minT = Math.min(...temps);
    const maxT = Math.max(...temps);
    const avgT = (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
    const minH = Math.min(...hums);
    const maxH = Math.max(...hums);
    const avgH = (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1);
    const optimalCount = historyLogs.filter(
      l => l.humidity >= 50 && l.humidity <= 62 && l.temperature >= 23.5 && l.temperature <= 26.5
    ).length;
    const optimalPercent = Math.round((optimalCount / historyLogs.length) * 100);
    return { minT, maxT, avgT, minH, maxH, avgH, optimalPercent };
  }, [historyLogs]);

  const filteredSensorLogs = useMemo(() => {
    return historyLogs.filter(log => {
      if (sensorFilterMode === 'cool') return log.ac_mode === 'cool';
      if (sensorFilterMode === 'deep_cool') return log.ac_mode === 'deep_cool';
      if (sensorFilterMode === 'dry') return log.ac_mode === 'dry';
      if (sensorFilterMode === 'off') return log.ac_mode === 'off';
      if (sensorFilterMode === 'high_hum') return log.humidity >= 67;
      if (sensorFilterMode === 'comfort') return log.humidity >= 50 && log.humidity <= 60;
      return true;
    });
  }, [historyLogs, sensorFilterMode]);

  const filteredSleepSessions = useMemo(() => {
    return sleepSessions.filter(s => {
      if (sleepFilterDate) {
        const d = new Date(s.started_at);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const sessionDateStr = `${y}-${m}-${day}`;
        if (sessionDateStr !== sleepFilterDate) return false;
      }
      const dur = s.duration_minutes || 0;
      if (sleepFilterType === 'long') return dur >= 360;
      if (sleepFilterType === 'short') return dur < 360;
      if (sleepFilterType === 'dehumidified') return (s.dry_mode_count || 0) > 0;
      return true;
    });
  }, [sleepSessions, sleepFilterType, sleepFilterDate]);

  const displayedSleepSessions = useMemo(() => {
    if (sleepFilterDate) {
      return filteredSleepSessions;
    }
    return filteredSleepSessions.slice(0, 7);
  }, [filteredSleepSessions, sleepFilterDate]);

  const sleepMetrics = useMemo(() => {
    const isCurrentlySleeping = acState?.power && (acState?.is_sleeping ?? false);
    const lastSession = sleepSessions[0];

    const duration = isCurrentlySleeping 
      ? inBedDurationMins 
      : (lastSession?.duration_minutes ?? inBedDurationMins);

    const hasRealData = duration >= 15;

    const durRatio = Math.min(duration / SLEEP_GOAL_MINS, 1.0);
    const durScore = durRatio * 60;
    const envScore = (stats.optimalPercent / 100) * 40;
    const score = hasRealData ? Math.max(0, Math.min(100, Math.round(durScore + envScore))) : null;
    const progressPct = hasRealData ? Math.min(100, Math.round((duration / SLEEP_GOAL_MINS) * 100)) : 0;

    const recentSessions = sleepSessions.slice(0, 7);
    const avgDailyMins = recentSessions.length > 0
      ? Math.round(recentSessions.reduce((acc, s) => acc + (s.duration_minutes || 0), 0) / recentSessions.length)
      : (hasRealData ? duration : 0);

    let startTimeStr = '--:--';
    let endTimeStr = '--:--';

    if (isCurrentlySleeping) {
      const startIso = acState?.session_started_at || acState?.updated_at;
      if (startIso) startTimeStr = new Date(startIso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      endTimeStr = 'กำลังนอนหลับ';
    } else if (lastSession) {
      startTimeStr = new Date(lastSession.started_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      endTimeStr = lastSession.ended_at ? new Date(lastSession.ended_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '--:--';
    }

    const weekDays = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
    const past7DaysData = Array.from({ length: 7 }, (_, i) => {
      const targetDay = new Date();
      targetDay.setDate(targetDay.getDate() - (6 - i));
      const targetDateStr = targetDay.toDateString();
      const match = sleepSessions.find(s => new Date(s.started_at).toDateString() === targetDateStr);
      const dayDur = match ? (match.duration_minutes || 0) : 0;
      return {
        label: weekDays[targetDay.getDay()],
        dateStr: targetDay.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }),
        hours: Number((dayDur / 60).toFixed(1)),
        mins: dayDur,
        isToday: i === 6
      };
    });

    return {
      duration,
      score,
      progressPct,
      avgDailyMins,
      isCurrentlySleeping,
      startTimeStr,
      endTimeStr,
      hasRealData,
      lastSession,
      recentSessions,
      past7DaysData
    };
  }, [sleepSessions, inBedDurationMins, acState, stats]);

  // จุดล่าสุดของชุดข้อมูลปัจจุบัน
  const latestPoint = useMemo(() => {
    return historyLogs.length > 0 ? historyLogs[historyLogs.length - 1] : null;
  }, [historyLogs]);

  // จุดที่กำลังแสดงรายละเอียด: ถ้าไม่มีการแตะจุดอื่น จะแสดงจุดล่าสุดเสมอ
  const activePoint = hoveredPoint || latestPoint;

  // คำนวณข้อมูลกราฟ เส้นแบ่งช่วงเวลา และระยะการเลื่อนซ้ายขวาไม่ให้เกินขอบ
  const chartData = useMemo(() => {
    if (historyLogs.length < 2) return null;
    const paddingLeft = 32;
    const paddingRight = 32;
    const height = 180;
    const paddingTop = 20;
    const paddingBottom = 34;

    const minPointSpacing = 22;
    const neededWidth = paddingLeft + paddingRight + (historyLogs.length - 1) * minPointSpacing;
    const width = Math.max(containerWidth || 360, neededWidth);
    const pointSpacing = (width - paddingLeft - paddingRight) / (historyLogs.length - 1);

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

    // สร้างเส้นแบ่งช่วงเวลา (Time Dividers)
    const t0 = new Date(historyLogs[0].created_at).getTime();
    const tEnd = new Date(historyLogs[historyLogs.length - 1].created_at).getTime();
    const totalMinutes = Math.max(1, (tEnd - t0) / 60000);

    let stepMinutes = 15;
    if (totalMinutes <= 45) stepMinutes = 5;
    else if (totalMinutes <= 120) stepMinutes = 15;
    else if (totalMinutes <= 360) stepMinutes = 30;
    else if (totalMinutes <= 720) stepMinutes = 60;
    else stepMinutes = 120;

    const timeDividers: { x: number; timeStr: string }[] = [];
    let lastX = -999;

    historyLogs.forEach((log, i) => {
      const dt = new Date(log.created_at);
      const m = dt.getMinutes();
      const x = getX(i);
      const isInterval = (m % stepMinutes === 0) && (i === 0 || new Date(historyLogs[i - 1].created_at).getMinutes() !== m);

      if (isInterval && (x - lastX >= 70)) {
        const timeStr = dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        timeDividers.push({ x, timeStr });
        lastX = x;
      }
    });

    if (timeDividers.length < 2) {
      const indexStep = Math.max(1, Math.floor(historyLogs.length / 5));
      for (let i = 0; i < historyLogs.length; i += indexStep) {
        const x = getX(i);
        const dt = new Date(historyLogs[i].created_at);
        timeDividers.push({
          x,
          timeStr: dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        });
      }
    }

    return { tempPath, humPath, dots, width, height, getYH, getYT, timeDividers, paddingLeft, paddingRight, paddingTop, paddingBottom };
  }, [historyLogs, containerWidth]);

  // เลื่อนหน้าจอกราฟไปที่จุดล่าสุด (ขวาสุด) เสมอเมื่อข้อมูลเปลี่ยน
  useEffect(() => {
    const timer = setTimeout(() => {
      if (chartScrollRef.current) {
        chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [chartData?.width, logRange, sensorFilterDate]);

  const handleCopyTableData = () => {
    const logsToCopy = filteredSensorLogs.length > 0 ? filteredSensorLogs : historyLogs;
    if (logsToCopy.length === 0) return;
    const header = `วันที่\tเวลา\tอุณหภูมิ (°C)\tความชื้น (%RH)\tโหมดแอร์\n`;
    const rows = logsToCopy.map(l => {
      const d = new Date(l.created_at);
      const dateStr = d.toLocaleDateString('th-TH');
      const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `${dateStr}\t${timeStr}\t${l.temperature.toFixed(1)}\t${l.humidity.toFixed(1)}\t${l.ac_mode || 'cool'}`;
    }).join('\n');
    navigator.clipboard.writeText(header + rows);
    setCopiedData(true);
    setTimeout(() => setCopiedData(false), 2500);
  };

  const handleDeleteSession = async (id?: number) => {
    if (!id) return;
    if (!window.confirm('ต้องการลบประวัติการนอนรอบนี้ใช่หรือไม่?')) return;
    await supabase.from('sleep_sessions').delete().eq('id', id);
    setSleepSessions(prev => prev.filter(s => s.id !== id));
  };

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
            className="mb-6 w-full rounded-2xl bg-slate-950 py-3.5 text-center text-3xl font-mono tracking-[0.4em] text-cyan-400 border border-slate-800 focus:border-cyan-500 focus:outline-none"
            placeholder="••••"
            autoFocus
          />
          <button type="submit" className="w-full rounded-2xl bg-cyan-500 py-3.5 text-sm font-semibold text-slate-950 transition active:scale-[0.98]">
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
        <span className="text-sm font-medium text-slate-400">กำลังเชื่อมต่อข้อมูลเรียลไทม์...</span>
      </div>
    );
  }

  const isSleeping = acState.power && (acState.is_sleeping ?? false);
  const isDehumMode = acState.power && (acState.mode === 'deep_cool' || (acState.target_temp === 23 && acState.mode !== 'dry'));
  const isDry = acState.power && acState.mode === 'dry';
  const scheduleEnabled = acState.schedule_enabled ?? false;
  const scheduleStart = acState.schedule_start || '20:00';
  const scheduleEnd = acState.schedule_end || '10:00';

  const formatTimerCountdown = (totalSec: number) => {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-[100dvh] bg-[#070b14] text-slate-100 flex flex-col items-center justify-between p-4 pb-24 font-sans select-none antialiased">
      {/* App Header */}
      <header className="w-full max-w-md flex items-center justify-between pt-1 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
              <span>LG Climate & Sleep Hub</span>
            </h1>
            <span className="flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse" title="Live Synced" />
          </div>
          <p className="text-[11px] font-medium text-slate-400">
            ห้องนอน 7.7 m² • LG S13LCN
          </p>
        </div>

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

      {/* ======================= TAB 1: หน้ารีโมทแอร์เต็มรูปแบบ + กราฟสด (DEFAULT HOME) ======================= */}
      {currentTab === 'remote' && (
        <div className="w-full max-w-md flex-1 space-y-3.5 animate-fadeIn">
          {/* Room Environment Badges */}
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
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Droplets className="h-5 w-5" />
              </div>
              <div>
                <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">ความชื้นห้อง</div>
                <div className="text-xl font-bold tracking-tight text-white">
                  {sensor.humidity !== null ? sensor.humidity.toFixed(1) : '--'}
                  <span className="text-xs font-normal text-slate-400 ml-0.5">%RH</span>
                </div>
              </div>
            </div>
          </div>

          {/* Central Air Conditioner Remote Dial */}
          <div className="rounded-3xl bg-gradient-to-b from-slate-900/95 via-slate-950 to-slate-950 border border-slate-800/90 p-5 shadow-2xl backdrop-blur-2xl relative">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Snowflake className="h-3.5 w-3.5 text-cyan-400" />
                  <span>LG In-Room Remote</span>
                </span>
                <span className="text-[10px] text-slate-400">
                  พัดลม: {acState.fan_speed === 'high' ? 'High' : acState.fan_speed === 'med' ? 'Med' : 'Low (รีดน้ำ)'}
                </span>
              </div>
              
              <div className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                !acState.power 
                  ? 'bg-slate-900 text-slate-500 border-slate-800' 
                  : isSleeping 
                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300 animate-pulse'
                    : isDry 
                      ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                      : isDehumMode
                        ? 'bg-teal-500/20 border-teal-500/40 text-teal-300 animate-pulse'
                        : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
              }`}>
                {!acState.power ? 'System OFF' : isSleeping ? 'Deep Sleep Mode' : isDry ? 'Dry Mode' : isDehumMode ? 'Dehumidify 23°' : 'Cooling'}
              </div>
            </div>

            {/* Stepper Temperature Display */}
            <div className="flex items-center justify-around py-2 my-1">
              <button
                disabled={loading || !acState.power || acState.target_temp <= 18}
                onClick={() => updateState({ target_temp: Math.max(18, acState.target_temp - 1), mode: 'cool' })}
                className="h-12 w-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white active:scale-95 disabled:opacity-30 transition"
              >
                <ChevronDown className="h-6 w-6" />
              </button>

              <div className="text-center">
                <div className="flex items-baseline justify-center">
                  <span className="text-6xl font-black tracking-tight text-white">
                    {acState.power ? (isDry ? '--' : acState.target_temp) : '--'}
                  </span>
                  {!isDry && acState.power && <span className="text-2xl font-light text-slate-400 ml-1">°C</span>}
                </div>
                <div className="text-[11px] text-emerald-400 font-semibold mt-1">
                  {acState.target_temp === 25 ? 'อุณหภูมินอนหลับลึก สบายตัวสูงสุด' : acState.target_temp === 24 ? 'โหมดรีดน้ำนุ่มนวล (Gentle Cool)' : acState.target_temp === 23 ? 'โหมดรีดน้ำเร่งด่วน 23°C' : 'โหมดควบคุมอุณหภูมิปกติ'}
                </div>
              </div>

              <button
                disabled={loading || !acState.power || acState.target_temp >= 30}
                onClick={() => updateState({ target_temp: Math.min(30, acState.target_temp + 1), mode: 'cool' })}
                className="h-12 w-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white active:scale-95 disabled:opacity-30 transition"
              >
                <ChevronUp className="h-6 w-6" />
              </button>
            </div>

            {/* Row 1: Quick Sleep & Chill Presets */}
            <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-slate-800/80">
              <button
                disabled={loading}
                onClick={() => updateState({ power: true, target_temp: 25, mode: 'cool' })}
                className={`py-2.5 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && acState.target_temp === 25 && acState.mode !== 'dry'
                    ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                    : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <SunDim className="h-4 w-4" />
                25°C นอนสบาย
              </button>

              <button
                disabled={loading}
                onClick={() => updateState({ power: true, target_temp: 24, mode: 'cool' })}
                className={`py-2.5 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && acState.target_temp === 24 && acState.mode !== 'dry'
                    ? 'bg-teal-500 text-slate-950 border-teal-400 shadow-[0_0_12px_rgba(20,184,166,0.3)]'
                    : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Droplets className="h-4 w-4" />
                24°C รีดน้ำนุ่มนวล
              </button>

              <button
                disabled={loading}
                onClick={() => updateState({ power: true, target_temp: 23, mode: 'cool' })}
                className={`py-2.5 px-2 rounded-2xl border text-xs font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && acState.target_temp === 23 && acState.mode !== 'dry'
                    ? 'bg-blue-500 text-white border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.3)]'
                    : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sparkles className="h-4 w-4" />
                23°C รีดน้ำเร่งด่วน
              </button>
            </div>

            {/* Row 2: Standard Remote Controls (Mode & Fan & Power) */}
            <div className="grid grid-cols-4 gap-2 mt-2">
              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ mode: 'cool', target_temp: 25 })}
                className={`py-2 rounded-xl border text-[11px] font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power && acState.mode === 'cool' && !isDehumMode
                    ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400'
                }`}
              >
                <Snowflake className="h-3.5 w-3.5" />
                โหมด Cool
              </button>

              <button
                disabled={loading || !acState.power}
                onClick={() => updateState({ mode: 'dry' })}
                className={`py-2 rounded-xl border text-[11px] font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  isDry
                    ? 'bg-blue-500/30 border-blue-400 text-blue-200'
                    : 'bg-slate-900/70 border-slate-800 text-slate-400'
                }`}
              >
                <Wind className="h-3.5 w-3.5" />
                โหมด Dry
              </button>

              <button
                disabled={loading || !acState.power}
                onClick={() => {
                  const currentFan = acState.fan_speed || 'low';
                  const nextFan = currentFan === 'low' ? 'med' : currentFan === 'med' ? 'high' : 'low';
                  updateState({ fan_speed: nextFan });
                }}
                className="py-2 rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 text-[11px] font-semibold flex flex-col items-center justify-center gap-1 active:scale-95"
              >
                <Activity className="h-3.5 w-3.5 text-cyan-400" />
                พัดลม: {acState.fan_speed === 'high' ? 'High' : acState.fan_speed === 'med' ? 'Med' : 'Low'}
              </button>

              <button
                disabled={loading}
                onClick={() => updateState({ power: !acState.power })}
                className={`py-2 rounded-xl border text-[11px] font-semibold flex flex-col items-center justify-center gap-1 transition active:scale-95 ${
                  acState.power
                    ? 'bg-rose-500/20 border-rose-500/50 text-rose-400'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <Power className="h-3.5 w-3.5" />
                {acState.power ? 'ปิดแอร์' : 'เปิดแอร์'}
              </button>
            </div>

            {/* Smart Phone Tracking Status Badge */}
            {acState.power && (
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs">
                <button
                  onClick={() => updateState({ is_sleeping: !(acState.is_sleeping ?? false) })}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-medium transition active:scale-95 ${
                    isSleeping
                      ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}
                >
                  {isSleeping ? <Moon className="h-3 w-3 text-indigo-400" /> : <Smartphone className="h-3 w-3 text-amber-400" />}
                  <span>{isSleeping ? 'สถานะ: วางมือถือนอนแล้ว' : 'สถานะ: ตื่น / เล่นมือถือ'}</span>
                </button>

                <span className="text-[10px] text-slate-400">
                  เปิดมาแล้ว: {formatHoursMins(inBedDurationMins)}
                </span>
              </div>
            )}
          </div>

          {/* Smart Timer & Scheduler Section */}
          <div className="space-y-1.5">
            {acState.timer_target_at && (
              <div className="rounded-2xl bg-cyan-950/60 border border-cyan-500/40 p-3 flex items-center justify-between text-xs backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
                  <span className="text-slate-200">
                    {acState.timer_action === 'turn_off' ? 'สั่งปิดแอร์ในอีก' : 'สั่งเปิดแอร์ในอีก'}:
                  </span>
                  <strong className="font-mono text-cyan-300 text-sm">
                    {formatTimerCountdown(remainingSeconds)}
                  </strong>
                </div>
                <button
                  onClick={handleCancelCountdown}
                  className="px-2.5 py-1 rounded-lg bg-rose-500/20 border border-rose-500/30 text-rose-300 hover:bg-rose-500/30 text-[10px] font-semibold flex items-center gap-1 active:scale-95"
                >
                  <Trash2 className="h-3 w-3" /> ยกเลิก
                </button>
              </div>
            )}

            {!acState.timer_target_at && (
              <button
                onClick={() => setShowTimerCard(!showTimerCard)}
                className="w-full py-2.5 px-3.5 rounded-2xl bg-slate-900/60 border border-slate-800 text-slate-300 hover:text-white flex items-center justify-between text-xs font-semibold transition active:scale-[0.99]"
              >
                <span className="flex items-center gap-2">
                  <TimerIcon className="h-3.5 w-3.5 text-cyan-400" />
                  <span>ระบบตั้งเวลา</span>
                  {scheduleEnabled && (
                    <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded-full">
                      เปิด {scheduleStart} - {scheduleEnd}
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-cyan-400 font-medium">
                  {showTimerCard ? 'ซ่อน ▲' : '+ จัดการเวลา ▼'}
                </span>
              </button>
            )}

            {showTimerCard && !acState.timer_target_at && (
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3 backdrop-blur-xl animate-fadeIn text-xs">
                <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800/80">
                  <button
                    onClick={() => setTimerSubTab('countdown')}
                    className={`py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                      timerSubTab === 'countdown' ? 'bg-cyan-500 text-slate-950' : 'text-slate-400'
                    }`}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    <span>อีกกี่นาที</span>
                  </button>
                  <button
                    onClick={() => setTimerSubTab('schedule')}
                    className={`py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                      timerSubTab === 'schedule' ? 'bg-cyan-500 text-slate-950' : 'text-slate-400'
                    }`}
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    <span>ช่วงเวลา</span>
                  </button>
                </div>

                {timerSubTab === 'countdown' && (
                  <div className="space-y-2 pt-1 animate-fadeIn">
                    <div className="grid grid-cols-4 gap-1.5">
                      {[15, 30, 60, 120].map((mins) => (
                        <button
                          key={mins}
                          onClick={() => handleStartCountdown(mins)}
                          className="py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-cyan-400 text-xs font-mono active:scale-95"
                        >
                          +{mins >= 60 ? `${mins / 60} ชม.` : `${mins} น.`}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 pt-1 border-t border-slate-800/80">
                      <span className="text-[11px] text-slate-400">ระบุเวลา:</span>
                      <input
                        type="number"
                        min="1"
                        max="720"
                        value={customTimerMinutes}
                        onChange={(e) => setCustomTimerMinutes(e.target.value)}
                        className="w-16 rounded-lg bg-slate-950 px-2 py-1 text-center font-mono text-cyan-300 border border-slate-800 text-xs"
                      />
                      <span className="text-[11px] text-slate-400">นาที</span>
                      <button
                        onClick={() => handleStartCountdown(Number(customTimerMinutes))}
                        className={`ml-auto px-3 py-1 rounded-lg font-bold text-xs active:scale-95 ${
                          acState.power ? 'bg-rose-500 text-white' : 'bg-cyan-500 text-slate-950'
                        }`}
                      >
                        {acState.power ? 'นับถอยหลังปิด' : 'นับถอยหลังเปิด'}
                      </button>
                    </div>
                  </div>
                )}

                {timerSubTab === 'schedule' && (
                  <div className="space-y-2.5 pt-1 animate-fadeIn">
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <div>
                        <div className="text-[11px] font-semibold text-slate-200">เปิดระบบตั้งเวลารายวัน</div>
                        <div className="text-[10px] text-slate-400">ทำงานอัตโนมัติตามเวลาเปิด-ปิด พร้อมโหมด Auto Guard</div>
                      </div>
                      <button
                        onClick={handleToggleSchedule}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold transition active:scale-95 ${
                          scheduleEnabled ? 'bg-emerald-500 text-slate-950 shadow-[0_0_10px_rgba(16,185,129,0.3)]' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {scheduleEnabled ? 'เปิดใช้งานอยู่' : 'ปิดอยู่'}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                        <label className="text-[10px] text-slate-400 block mb-1">เวลาเริ่มเปิดแอร์ (Start)</label>
                        <input
                          type="time"
                          value={scheduleStart}
                          onChange={(e) => handleSaveScheduleTimes(e.target.value, scheduleEnd)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 font-mono text-cyan-300 text-xs focus:outline-none focus:border-cyan-500"
                        />
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                        <label className="text-[10px] text-slate-400 block mb-1">เวลาสั่งปิดแอร์ (End)</label>
                        <input
                          type="time"
                          value={scheduleEnd}
                          onChange={(e) => handleSaveScheduleTimes(scheduleStart, e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 font-mono text-cyan-300 text-xs focus:outline-none focus:border-cyan-500"
                        />
                      </div>
                    </div>

                    <div className="p-2 rounded-xl bg-slate-900/60 border border-slate-800/80 text-[10px] text-slate-400 text-center">
                      * เมื่อถึงเวลา {scheduleStart} แอร์จะเปิดอัตโนมัติ (Cool 25°C + Auto Guard) และสั่งปิดเมื่อถึง {scheduleEnd}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Integrated Live Trend Chart & Redesigned Log Table */}
          <div className="rounded-3xl bg-slate-900/80 border border-slate-800 p-4 backdrop-blur-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-cyan-400" /> สภาพอากาศสด & Healthy Zone
              </span>

              <div className="flex items-center gap-1.5">
                {!isHistoricalView ? (
                  <select
                    value={logRange}
                    onChange={(e) => setLogRange(Number(e.target.value))}
                    className="bg-slate-900 text-slate-300 text-[10px] rounded-lg px-2 py-1 border border-slate-800 focus:outline-none"
                  >
                    <option value={30}>30 น.</option>
                    <option value={60}>1 ชม.</option>
                    <option value={180}>3 ชม.</option>
                    <option value={360}>6 ชม.</option>
                  </select>
                ) : (
                  <span className="text-[10px] text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30 font-medium">
                    ดูย้อนหลัง
                  </span>
                )}

                <button
                  onClick={handleCopyTableData}
                  className="px-2.5 py-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 text-[10px] font-semibold flex items-center gap-1 hover:bg-cyan-500/20 active:scale-95"
                >
                  {copiedData ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copiedData ? 'คัดลอก' : 'Copy'}
                </button>
              </div>
            </div>

            {/* SVG Chart with Time Dividers and Bounded Scrolling */}
            <div 
              ref={chartScrollRef}
              className="relative w-full h-44 bg-slate-950/70 rounded-2xl overflow-x-auto overflow-y-hidden border border-slate-900 scrollbar-thin scrollbar-thumb-slate-800 overscroll-x-contain touch-pan-x"
            >
              {chartData ? (
                <div style={{ width: `${chartData.width}px` }} className="h-full relative">
                  <svg viewBox={`0 0 ${chartData.width} ${chartData.height}`} className="w-full h-full block">
                    {/* Healthy Zone: 50% - 60% RH */}
                    <rect
                      x="0"
                      y={chartData.getYH(60)}
                      width={chartData.width}
                      height={chartData.getYH(50) - chartData.getYH(60)}
                      fill="rgba(16, 185, 129, 0.08)"
                    />

                    {/* เส้นแบ่งช่วงเวลา (Time Dividers) */}
                    {chartData.timeDividers.map((div, i) => (
                      <g key={`div-${i}`}>
                        <line
                          x1={div.x}
                          y1={chartData.paddingTop}
                          x2={div.x}
                          y2={chartData.height - chartData.paddingBottom}
                          stroke="#334155"
                          strokeWidth="1"
                          strokeDasharray="4 4"
                          opacity="0.45"
                        />
                        <text
                          x={div.x}
                          y={chartData.height - 12}
                          textAnchor="middle"
                          fill="#64748b"
                          fontSize="10"
                          fontFamily="monospace"
                          fontWeight="600"
                        >
                          {div.timeStr}
                        </text>
                      </g>
                    ))}

                    <path d={chartData.humPath} fill="none" stroke="#06b6d4" strokeWidth="2.2" strokeLinecap="round" />
                    <path d={chartData.tempPath} fill="none" stroke="#f59e0b" strokeWidth="2.2" strokeLinecap="round" />

                    {/* จุดข้อมูล พร้อมการแสดงไฮไลต์จุดล่าสุดเสมอ */}
                    {chartData.dots.map((d, i) => {
                      const isSelected = activePoint?.id === d.log.id || (!hoveredPoint && i === chartData.dots.length - 1);
                      return (
                        <g key={d.log.id || i} className="cursor-pointer" onClick={() => setHoveredPoint(d.log)}>
                          <circle cx={d.x} cy={d.yt} r="14" fill="transparent" />
                          {isSelected && (
                            <circle
                              cx={d.x}
                              cy={d.yt}
                              r="9"
                              fill="none"
                              stroke="#f59e0b"
                              strokeWidth="1.5"
                              opacity="0.5"
                              className="animate-pulse"
                            />
                          )}
                          <circle
                            cx={d.x}
                            cy={d.yt}
                            r={isSelected ? "6" : "2.5"}
                            fill="#f59e0b"
                            stroke={isSelected ? "#ffffff" : "none"}
                            strokeWidth={isSelected ? "2" : "0"}
                          />
                        </g>
                      );
                    })}
                  </svg>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  รอรับข้อมูลเซนเซอร์...
                </div>
              )}
            </div>

            {/* การ์ดรายละเอียดจุดที่เลือก (แสดงจุดล่าสุดเสมอ แม้ว่าจะกดตัวกรองใดๆ) */}
            {activePoint ? (
              <div className="rounded-2xl bg-slate-950 p-3 border border-slate-800 flex items-center justify-between text-xs animate-fadeIn shadow-lg">
                <div>
                  <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5">
                    <Clock className="h-3 w-3 text-cyan-400" />
                    <span>{new Date(activePoint.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span>•</span>
                    <span>{new Date(activePoint.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</span>
                    {activePoint.id === latestPoint?.id && (
                      <span className="flex items-center gap-1 text-[9px] text-emerald-400 font-sans font-bold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        ล่าสุด
                      </span>
                    )}
                  </div>
                  <div className="font-semibold text-slate-200 mt-1 flex items-center gap-1.5">
                    <span>แอร์:</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${
                      activePoint.ac_mode === 'deep_cool' ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40' :
                      activePoint.ac_mode === 'cool' ? 'bg-emerald-500/20 text-emerald-300' :
                      activePoint.ac_mode === 'dry' ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {activePoint.ac_mode === 'deep_cool' ? 'รีดน้ำ' : activePoint.ac_mode || 'OFF'}
                    </span>
                    {activePoint.humidity >= 67 ? (
                      <span className="text-[10px] text-rose-400 font-normal">ชื้นสูงสะสม</span>
                    ) : activePoint.humidity <= 60 && activePoint.humidity >= 50 ? (
                      <span className="text-[10px] text-emerald-400 font-normal">โซนสบายตัว</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-amber-400 font-bold text-sm">{activePoint.temperature.toFixed(1)}°C</div>
                    <div className="text-cyan-400 font-bold text-sm">{activePoint.humidity.toFixed(1)}%RH</div>
                  </div>
                  {hoveredPoint && (
                    <button 
                      onClick={() => setHoveredPoint(null)}
                      className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white active:scale-95"
                      title="กลับไปจุดล่าสุด"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-center text-[10px] text-slate-500">รอรับข้อมูลเซนเซอร์...</p>
            )}

            {/* Redesigned Climate Sensor Table with Date & Mode Filters */}
            <div className="pt-2 border-t border-slate-800/80">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <TableIcon className="h-3.5 w-3.5 text-cyan-400" />
                  <span className="text-[11px] font-semibold text-slate-300">
                    ตารางบันทึกเซนเซอร์ ({filteredSensorLogs.length} / {historyLogs.length})
                  </span>
                </div>
                <button 
                  onClick={() => setShowRawTable(!showRawTable)} 
                  className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
                >
                  {showRawTable ? 'ย่อตาราง ▲' : 'เปิดดูตาราง ▼'}
                </button>
              </div>

              {showRawTable && (
                <div className="space-y-2 animate-fadeIn">
                  <div className="grid grid-cols-2 gap-2 p-2.5 rounded-2xl bg-slate-950 border border-slate-800 text-xs">
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">เลือกวันที่จากฐานข้อมูล</label>
                      <input 
                        type="date"
                        value={sensorFilterDate}
                        onChange={(e) => handleDateFilterChange(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-1.5 font-mono text-cyan-300 text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">กรองประเภท / โหมด</label>
                      <select
                        value={sensorFilterMode}
                        onChange={(e) => setSensorFilterMode(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                      >
                        <option value="all">ทั้งหมด (All)</option>
                        <option value="cool">โหมด Cool</option>
                        <option value="deep_cool">โหมด รีดน้ำ</option>
                        <option value="dry">โหมด Dry</option>
                        <option value="off">โหมด OFF (ปิดแอร์)</option>
                        <option value="high_hum">ชื้นสะสมสูง (&ge; 67%)</option>
                        <option value="comfort">Healthy Zone (50-60%)</option>
                      </select>
                    </div>
                    {(sensorFilterDate || sensorFilterMode !== 'all') && (
                      <div className="col-span-2 flex items-center justify-between pt-1 border-t border-slate-800/80">
                        <span className="text-[10px] text-slate-400">
                          {sensorFilterDate ? `กำลังดูข้อมูลของวันที่: ${new Date(sensorFilterDate).toLocaleDateString('th-TH')}` : 'กำลังกรองข้อมูล'}
                        </span>
                        <button
                          onClick={() => {
                            setSensorFilterDate('');
                            setSensorFilterMode('all');
                            fetchAnalyticsData();
                          }}
                          className="text-[10px] text-rose-400 hover:underline flex items-center gap-1 font-medium"
                        >
                          <X className="h-3 w-3" /> ล้างตัวกรอง (กลับไปดูสด)
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-950/90 shadow-xl">
                    <div className="max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 text-[11px] font-semibold text-slate-400 backdrop-blur-md">
                          <tr>
                            <th className="py-2.5 px-3">วัน / เวลา</th>
                            <th className="py-2.5 px-2 text-amber-400">อุณหภูมิ</th>
                            <th className="py-2.5 px-2 text-cyan-400">ความชื้น</th>
                            <th className="py-2.5 px-3 text-right">สถานะโหมด</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {filteredSensorLogs.length > 0 ? (
                            filteredSensorLogs.map((log) => {
                              const d = new Date(log.created_at);
                              const dateBadge = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
                              const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                              return (
                                <tr key={log.id} className="transition-colors hover:bg-slate-900/60">
                                  <td className="py-2 px-3">
                                    <div className="text-[10px] text-slate-400 font-sans">{dateBadge}</div>
                                    <div className="text-slate-200 font-semibold">{timeStr}</div>
                                  </td>
                                  <td className="py-2 px-2 font-bold text-amber-300">
                                    {log.temperature.toFixed(1)}°C
                                  </td>
                                  <td className="py-2 px-2 font-bold">
                                    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${
                                      log.humidity <= 60 
                                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' 
                                        : log.humidity >= 67 
                                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30 animate-pulse'
                                          : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                                    }`}>
                                      {log.humidity.toFixed(1)}%
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-sans font-semibold uppercase tracking-wider ${
                                      log.ac_mode === 'deep_cool'
                                        ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40 shadow-[0_0_8px_rgba(20,184,166,0.3)]'
                                        : log.ac_mode === 'cool'
                                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                          : log.ac_mode === 'dry'
                                            ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                                            : 'bg-slate-800/80 text-slate-400 border border-slate-700/60'
                                    }`}>
                                      {log.ac_mode === 'deep_cool' ? 'deep cool' : log.ac_mode || 'off'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })
                          ) : (
                            <tr>
                              <td colSpan={4} className="py-6 text-center text-slate-500 text-xs">
                                ไม่พบข้อมูลในวันที่หรือเงื่อนไขที่เลือก
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ======================= TAB 2: วัดการนอนจริงจากการใช้มือถือ (PROFESSIONAL DARK HEALTH) ======================= */}
      {currentTab === 'sleep' && (
        <div className="w-full max-w-md flex-1 space-y-3.5 animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between px-1">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400">SLEEP RECOVERY</span>
              <h2 className="text-lg font-black text-white">
                {new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'short' })}
              </h2>
            </div>
            <span className="text-xs bg-slate-900 text-slate-300 border border-slate-800 px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5">
              <Moon className="h-3.5 w-3.5 text-indigo-400" /> Phone Screen Tracking
            </span>
          </div>

          {/* Card 1: Clean KPI Summary (จัดสมดุลและระยะห่างไม่ให้ล้น) */}
          <div className="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 sm:p-5 shadow-xl backdrop-blur-xl space-y-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-slate-400 block mb-0.5">เวลานอนรอบล่าสุด</span>
                <div className="text-3xl sm:text-4xl font-black text-white tracking-tight truncate">
                  {sleepMetrics.hasRealData ? formatHoursMins(sleepMetrics.duration) : '--'}
                </div>
              </div>

              <div className="text-right shrink-0">
                <span className="text-xs font-semibold text-slate-400 block mb-0.5">Sleep Score</span>
                <div className="flex items-baseline justify-end gap-1">
                  <span className="text-2xl sm:text-3xl font-black text-slate-100">
                    {sleepMetrics.score !== null ? sleepMetrics.score : '--'}
                  </span>
                  <span className="text-xs text-slate-400 font-semibold">/100</span>
                </div>
              </div>
            </div>

            {/* Progress Bar เทียบเป้าหมาย */}
            <div className="space-y-1.5 pt-0.5">
              <div className="flex justify-between items-center text-[11px] text-slate-400">
                <span>เทียบเป้าหมาย 8 ชั่วโมง</span>
                <span className="font-mono text-slate-200 font-bold">{sleepMetrics.progressPct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-950 p-0.5 border border-slate-800 overflow-hidden">
                <div 
                  style={{ width: `${sleepMetrics.progressPct}%` }}
                  className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                />
              </div>
            </div>

            {/* 3 Metric Pills สมมาตร ไม่บีบตัวหนังสือ */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-center">
              <div className="p-2 sm:p-2.5 rounded-2xl bg-slate-950/60 border border-slate-800/60 flex flex-col justify-center">
                <div className="text-[10px] text-slate-400 truncate">สถานะจอมือถือ</div>
                <div className="text-xs font-bold text-slate-200 mt-0.5 truncate">
                  {isSleeping ? 'จอดับต่อเนื่อง' : 'เปิดจอใช้งาน'}
                </div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-2xl bg-slate-950/60 border border-slate-800/60 flex flex-col justify-center">
                <div className="text-[10px] text-slate-400 truncate">อุณหภูมิห้อง</div>
                <div className="text-xs font-bold text-amber-300 mt-0.5">
                  {sensor.temperature !== null ? `${sensor.temperature.toFixed(1)}°C` : '--'}
                </div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-2xl bg-slate-950/60 border border-slate-800/60 flex flex-col justify-center">
                <div className="text-[10px] text-slate-400 truncate">ความชื้นเฉลี่ย</div>
                <div className="text-xs font-bold text-cyan-300 mt-0.5">
                  {sensor.humidity !== null ? `${sensor.humidity.toFixed(1)}%` : '--'}
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: 7-Day Sleep Duration Column Chart (สมมาตร ไม่ทับซ้อน คำไม่ล้นขอบ) */}
          <div className="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 sm:p-4.5 backdrop-blur-xl space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <BarChart2 className="h-4 w-4 text-indigo-400 shrink-0" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200 truncate">
                  สถิติเวลานอน 7 วัน
                </span>
              </div>
              <span className="text-[10px] sm:text-[11px] text-slate-300 font-mono bg-slate-950/90 px-2 py-0.5 rounded-lg border border-slate-800 shrink-0">
                เฉลี่ย {formatHoursMins(sleepMetrics.avgDailyMins)}/วัน
              </span>
            </div>

            {/* Vertical Column Chart */}
            <div className="pt-5 pb-1">
              {(() => {
                const maxHoursInWeek = Math.max(8.5, ...sleepMetrics.past7DaysData.map(d => d.hours));
                const chartCeiling = Math.ceil(maxHoursInWeek + 1);
                const targetLineBottomPct = Math.round((8 / chartCeiling) * 100);

                return (
                  <div className="relative h-32 w-full flex items-end justify-between border-b border-slate-800 pb-1.5">
                    <div 
                      style={{ bottom: `${targetLineBottomPct}%` }}
                      className="absolute left-0 right-0 border-b border-dashed border-slate-700/70 pointer-events-none z-0"
                    >
                    </div>

                    {sleepMetrics.past7DaysData.map((day, idx) => {
                      const barHeightPct = Math.min(100, Math.round((day.hours / chartCeiling) * 100));
                      return (
                        <div key={idx} className="flex-1 flex flex-col items-center z-10">
                          <div className="h-4 flex items-center justify-center mb-1">
                            <span className="text-[9px] font-mono text-slate-400">
                              {day.hours > 0 ? `${day.hours}h` : ''}
                            </span>
                          </div>

                          <div className="h-20 w-4 sm:w-5 bg-slate-950 rounded-lg p-0.5 flex items-end justify-center border border-slate-800/80">
                            <div 
                              style={{ height: `${barHeightPct}%` }}
                              className={`w-full rounded-md transition-all duration-500 ${
                                day.isToday 
                                  ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]' 
                                  : day.hours >= 7 
                                    ? 'bg-slate-600 hover:bg-slate-500' 
                                    : 'bg-slate-700/50'
                              }`}
                            />
                          </div>

                          <span className={`text-[10px] mt-1.5 font-medium ${
                            day.isToday ? 'text-indigo-400 font-bold' : 'text-slate-400'
                          }`}>
                            {day.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <p className="text-[10px] text-slate-500 text-center leading-normal pt-1">
              * วัดจริงจากช่วงจอดับสนิทต่อเนื่องจนถึงเวลาเปิดจอใช้งานในตอนเช้า
            </p>
          </div>

          {/* Card 3: Session Details & Night Phone Activity */}
          <div className="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 backdrop-blur-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-1.5">
                <Smartphone className="h-3.5 w-3.5 text-amber-400" />
                <span>รายละเอียดรอบการนอนจริง</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {sleepMetrics.startTimeStr} - {sleepMetrics.endTimeStr}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800/70">
                <div className="text-[10px] text-slate-400">เวลาเริ่มหลับ (จอดับ)</div>
                <div className="text-sm font-bold text-slate-200 mt-0.5">
                  {sleepMetrics.startTimeStr}
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5">Screen-Off Event</div>
              </div>

              <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800/70">
                <div className="text-[10px] text-slate-400">เวลาตื่นนอน (เปิดจอ)</div>
                <div className="text-sm font-bold text-slate-200 mt-0.5">
                  {sleepMetrics.endTimeStr}
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5">Screen-On Event</div>
              </div>
            </div>

            <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800/70 flex items-center justify-between text-xs">
              <div>
                <div className="text-[10px] text-slate-400">แอร์รีดน้ำระหว่างนอน</div>
                <div className="text-sm font-bold text-cyan-300 mt-0.5">
                  {sleepMetrics.lastSession?.dry_mode_count ?? 0} ครั้ง
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-400">Healthy Zone ตอนนอน</div>
                <div className="text-sm font-bold text-emerald-400 mt-0.5">
                  {stats.optimalPercent}%
                </div>
              </div>
            </div>
          </div>

          {/* Card 4: ประวัติการนอนย้อนหลัง พร้อมตัวกรอง (Sleep History Filter Toolbar) */}
          <div className="rounded-3xl bg-slate-900/90 border border-slate-800 p-4 backdrop-blur-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-indigo-400" />
                <span>
                  ประวัติเซสชัน {sleepFilterDate ? `(${displayedSleepSessions.length} รายการ)` : `(7 วันล่าสุด)`}
                </span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">
                ทั้งหมด {sleepSessions.length} รอบ
              </span>
            </div>

            {/* Filter Toolbar for Sleep Sessions */}
            <div className="grid grid-cols-2 gap-2 p-2.5 rounded-2xl bg-slate-950 border border-slate-800 text-xs">
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">เลือกวันที่</label>
                <input 
                  type="date"
                  value={sleepFilterDate}
                  onChange={(e) => setSleepFilterDate(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg p-1.5 font-mono text-cyan-300 text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">กรองประเภทการนอน</label>
                <select
                  value={sleepFilterType}
                  onChange={(e) => setSleepFilterType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg p-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                >
                  <option value="all">ทั้งหมด (All)</option>
                  <option value="long">นอนยาว (&ge; 6 ชม.)</option>
                  <option value="short">นอนสั้น (&lt; 6 ชม.)</option>
                  <option value="dehumidified">คืนที่มีรีดน้ำ</option>
                </select>
              </div>
              {(sleepFilterDate || sleepFilterType !== 'all') && (
                <div className="col-span-2 flex justify-end pt-1 border-t border-slate-800/80">
                  <button
                    onClick={() => {
                      setSleepFilterDate('');
                      setSleepFilterType('all');
                    }}
                    className="text-[10px] text-rose-400 hover:underline flex items-center gap-1 font-medium"
                  >
                    <X className="h-3 w-3" /> ล้างตัวกรอง
                  </button>
                </div>
              )}
            </div>

            {/* Sessions List */}
            {displayedSleepSessions.length > 0 ? (
              <div className="space-y-2 pt-1">
                {displayedSleepSessions.map((s, idx) => {
                  const dur = s.duration_minutes || 0;
                  const pct = Math.min(100, Math.round((dur / SLEEP_GOAL_MINS) * 100));
                  return (
                    <div key={idx} className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 text-xs space-y-1.5 hover:border-slate-700 transition">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-slate-200">
                          {new Date(s.started_at).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-slate-100">
                            {Math.floor(dur / 60)} ชม. {dur % 60} น.
                          </span>
                          <button
                            onClick={() => handleDeleteSession(s.id)}
                            className="text-slate-500 hover:text-rose-400 p-1 transition rounded hover:bg-slate-900 active:scale-90"
                            title="ลบประวัตินี้"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      
                      <div className="h-1.5 w-full rounded-full bg-slate-900 overflow-hidden">
                        <div 
                          style={{ width: `${pct}%` }} 
                          className="h-full rounded-full bg-indigo-500"
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                        <span>
                          {new Date(s.started_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} - {s.ended_at ? new Date(s.ended_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : 'กำลังนอน'}
                        </span>
                        <span>
                          {s.avg_temp ? `${s.avg_temp.toFixed(1)}°C` : '--'} • {s.avg_humidity ? `${s.avg_humidity.toFixed(1)}%` : '--'}
                          {(s.dry_mode_count || 0) > 0 && <span className="ml-1 text-cyan-400 font-semibold">(รีดน้ำ {s.dry_mode_count}x)</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {!sleepFilterDate && filteredSleepSessions.length > 7 && (
                  <p className="text-[10px] text-slate-500 text-center pt-1.5">
                    * จำกัดแสดง 7 วันล่าสุด (หากต้องการดูวันอื่น สามารถเลือกวันที่ในตัวกรองด้านบนได้)
                  </p>
                )}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-slate-500">
                ไม่พบประวัติการนอนตามตัวกรองที่เลือก
              </div>
            )}
          </div>
        </div>
      )}

      {/* ======================= BOTTOM NAVIGATION DOCK (2 TABS) ======================= */}
      <nav className="fixed bottom-3 w-[calc(100%-2rem)] max-w-md bg-slate-900/90 border border-slate-800 rounded-3xl p-1.5 backdrop-blur-2xl shadow-2xl flex items-center justify-around z-50">
        <button
          onClick={() => setCurrentTab('remote')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-3 rounded-2xl text-xs font-semibold transition active:scale-95 ${
            currentTab === 'remote'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Sliders className="h-4 w-4" />
          <span>รีโมท & อากาศ</span>
        </button>

        <button
          onClick={() => {
            setCurrentTab('sleep');
            fetchAnalyticsData(sensorFilterDate || undefined);
          }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-3 rounded-2xl text-xs font-semibold transition active:scale-95 ${
            currentTab === 'sleep'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Moon className="h-4 w-4" />
          <span>วัดการนอน</span>
        </button>
      </nav>
    </div>
  );
}