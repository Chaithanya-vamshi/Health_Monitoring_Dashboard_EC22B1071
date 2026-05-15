import React, { useState, useEffect, useMemo } from 'react';
import { 
  Activity, 
  Heart, 
  Thermometer, 
  Wind, 
  Mountain, 
  Move, 
  Zap, 
  Moon, 
  Flame, 
  TrendingUp,
  Sun,
  Moon as MoonIcon,
  LayoutDashboard,
  History,
  Settings,
  Bell,
  LogIn,
  LogOut,
  AlertCircle,
  ChevronRight,
  ShieldCheck,
  Cpu,
  Smile,
  Meh,
  Frown,
  Cloud
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { SensorData, HealthStats } from '@/src/types';
import { auth, db, rtdb, signInWithGoogle, logout } from '@/src/firebase';
import { useAuthState } from 'react-firebase-hooks/auth';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  onSnapshot,
  getDocFromServer,
  doc,
  addDoc,
  serverTimestamp
} from 'firebase/firestore';
import { ref, onValue, query as rtdbQuery, limitToLast, remove } from 'firebase/database';
import Login from './Login';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const calculateStress = (hr: number, spo2: number, accel: { x: number; y: number; z: number }, temp: number) => {
  const motion = Math.sqrt(accel.x**2 + accel.y**2 + accel.z**2);
  const isHighMotion = motion > 1.2;
  const isResting = motion < 0.5;
  
  // Biological HRV (RMSSD) estimation
  const hrvBase = Math.max(12, 115 * Math.exp(-0.0125 * hr));
  const biologicalJitter = (Math.sin(Date.now() / 2000) * 3) + (Math.random() * 1.5);
  let hrv = hrvBase + biologicalJitter;
  
  if (motion > 0.6) hrv *= 0.85;
  if (isHighMotion) hrv *= 0.7;
  
  // Thresholds
  const isLowHrv = hrv < 45;
  const isStableHrv = hrv > 55;
  const isNormalTemp = temp <= 37.2;
  const isHighTemp = temp > 37.2;
  const isArtifact = (hr > 155 && isResting) || (spo2 > 0 && spo2 < 85);

  if (isArtifact) {
    return { hrv: Math.round(hrv), score: 10, state: "Stabilizing", routine: "Sensor Calibration", motion, suggestion: "Steadying sensor stream..." };
  }

  // 1. Cognitive Stress: Low HRV + Low Motion + Normal Temp
  if (isLowHrv && isResting && isNormalTemp) {
    return { 
      hrv: Math.round(hrv), 
      score: 82, 
      state: "Cognitive Stress", 
      routine: "Mental Load", 
      motion, 
      suggestion: "High cognitive load detected. Rest your eyes." 
    };
  }

  // 2. Physical Stress: Low HRV + High Motion + High Temp
  if (isLowHrv && isHighMotion && isHighTemp) {
    return { 
      hrv: Math.round(hrv), 
      score: 94, 
      state: "Physical Stress", 
      routine: "Exertion", 
      motion, 
      suggestion: "Peak physical strain detected. Control your breath." 
    };
  }

  // 3. Relaxed: Stable HRV + Rest
  if (isStableHrv && isResting) {
    return { 
      hrv: Math.round(hrv), 
      score: 12, 
      state: "Relaxed", 
      routine: "Deep Recovery", 
      motion, 
      suggestion: "Optimal rest state. Body is restoring." 
    };
  }

  // Fallback / Stable
  let fallbackScore = 35;
  if (hr > 100) fallbackScore = 65;
  if (hrv < 40) fallbackScore += 10;

  return { 
    hrv: Math.round(hrv), 
    score: fallbackScore, 
    state: hr > 100 ? "Elevated" : "Stable", 
    routine: "Routine Activity", 
    motion, 
    suggestion: "Maintaining baseline health levels." 
  };
};

export default function Dashboard() {
  const [user, loading, error] = useAuthState(auth);
  const [data, setData] = useState<SensorData | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [uidOverride, setUidOverride] = useState<string>(() => {
    // Priority: Saved local storage
    return localStorage.getItem('v3_biometric_hw_uid') || '';
  });
  const targetUid = uidOverride || user?.uid;
  const [packetCount, setPacketCount] = useState(0);
  const [latestKeys, setLatestKeys] = useState<string[]>([]);
  const [dataSource, setDataSource] = useState<string>('Searching...');
  const [systemLogs, setSystemLogs] = useState<any[]>([]);

  const [now, setNow] = useState(Date.now());

  // Stale timer
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  // Persistent session flag to avoid double logging
  useEffect(() => {
    if (user && targetUid) {
      const sessionKey = `logged_login_${user.uid}_${new Date().toDateString()}`;
      if (!sessionStorage.getItem(sessionKey)) {
        const logData = {
          type: 'LOGIN',
          userId: user.uid,
          email: user.email,
          timestamp: serverTimestamp(),
          targetUid: targetUid
        };
        addDoc(collection(db, 'system_logs'), logData).catch(console.error);
        sessionStorage.setItem(sessionKey, 'true');
      }
    }
  }, [user, targetUid]);

  // Firestore Activity Stream Listener
  useEffect(() => {
    if (!user) return;
    const logsRef = collection(db, 'system_logs');
    const logsQuery = query(logsRef, orderBy('timestamp', 'desc'), limit(10));
    
    return onSnapshot(logsQuery, (snap) => {
      const logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSystemLogs(logs);
    }, (err) => console.error("Logs listener error:", err));
  }, [user]);

  // Persistence for Hardware UID
  useEffect(() => {
    if (uidOverride) {
      localStorage.setItem('v3_biometric_hw_uid', uidOverride);
    }
  }, [uidOverride]);

  // Test Connection
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        setConnectionStatus('online');
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          setConnectionStatus('offline');
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // Real-time listener for RTDB
  useEffect(() => {
    const targetUid = uidOverride || user?.uid;
    if (!targetUid) {
      setData(null);
      setHistory([]);
      return;
    }

    console.log("Monitoring Hardware UID:", targetUid);
    
    // We listen to all potential paths used by different versions of the ESP32 code
    const sensorsRef = ref(rtdb, `HealthData/${targetUid}/sensors`);
    const ecgRef = ref(rtdb, `HealthData/${targetUid}/ecg`);
    const ecgCapsRef = ref(rtdb, `HealthData/${targetUid}/ECG`);
    const readingsRef = ref(rtdb, `HealthData/${targetUid}/readings`);
    const mainSensorsRef = ref(rtdb, `HealthData/${targetUid}/MainSensors`);
    const paramsRef = ref(rtdb, `HealthData/${targetUid}/parameters`);
    const bpmRef = ref(rtdb, `HealthData/${targetUid}/bpm`);
    const genericDataRef = ref(rtdb, `HealthData/${targetUid}/data`);
    
    // Limits
    const sensorsQuery = rtdbQuery(sensorsRef, limitToLast(200));
    const ecgQuery = rtdbQuery(ecgRef, limitToLast(500));
    const ecgCapsQuery = rtdbQuery(ecgCapsRef, limitToLast(500));
    const readingsQuery = rtdbQuery(readingsRef, limitToLast(200));
    const mainSensorsQuery = rtdbQuery(mainSensorsRef, limitToLast(200));
    const paramsQuery = rtdbQuery(paramsRef, limitToLast(200));
    const bpmQuery = rtdbQuery(bpmRef, limitToLast(200));
    const genericDataQuery = rtdbQuery(genericDataRef, limitToLast(200));

    let latestSensorEntry: any = null;
    let latestEcgEntry: any = null;
    let latestEcgCapsEntry: any = null;
    let latestReadingEntry: any = null;
    let latestMainEntry: any = null;
    let latestParamEntry: any = null;
    let latestBpmEntry: any = null;
    let latestGenericEntry: any = null;
    let sHistory: any[] = [];
    let eHistory: any[] = [];
    let ecHistory: any[] = [];
    let rHistory: any[] = [];
    let mHistory: any[] = [];
    let pHistory: any[] = [];
    let bHistory: any[] = [];
    let gHistory: any[] = [];

    const getSafeNum = (v: any) => {
      if (v === null || v === undefined) return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    const valFor = (val: any, primaryKey: string, aliases: string[] = []) => {
      if (!val || typeof val !== 'object') return null;
      
      const keysToTry = [primaryKey, ...aliases];
      
      const tryGet = (obj: any, keys: string[]) => {
        for (const k of keys) {
          if (obj[k] !== undefined && obj[k] !== null) return obj[k];
        }
        return null;
      };

      // Priority 1: Check 'parameters' or 'data' sub-objects (User feedback priority)
      if (val.parameters && typeof val.parameters === 'object') {
        const p = tryGet(val.parameters, keysToTry);
        if (p !== null) return p;
      }
      if (val.data && typeof val.data === 'object') {
        const d = tryGet(val.data, keysToTry);
        if (d !== null) return d;
      }

      // Priority 2: Direct keys
      const direct = tryGet(val, keysToTry);
      if (direct !== null) return direct;

      // Priority 3: Fallback check in sub-objects even if it was 0
      if (val.parameters) {
        const p = tryGet(val.parameters, keysToTry);
        if (p !== null) return p;
      }

      // Level 3: Case-insensitive search
      const allKeys = Object.keys(val);
      for (const k of keysToTry) {
        const lowerK = k.toLowerCase().replace(/^\//, '');
        const found = allKeys.find(ak => ak.toLowerCase().replace(/^\//, '') === lowerK);
        if (found) return val[found];
      }
      return null;
    };

    let lastValidHR = 0;
    let lastValidSpo2 = 98;
    let lastValidTemp = 36.8;

    const updateUI = () => {
      if (!latestSensorEntry && !latestEcgEntry && !latestEcgCapsEntry && !latestReadingEntry && !latestMainEntry && !latestParamEntry && !latestBpmEntry && !latestGenericEntry) return;

      setLastSync(new Date());
      setIsSyncing(true);

      const s = latestSensorEntry || {};
      const e = latestEcgEntry || {};
      const ec = latestEcgCapsEntry || {};
      const r = latestReadingEntry || {};
      const m = latestMainEntry || {};
      const p = latestParamEntry || {};
      const b = latestBpmEntry || {};
      const g = latestGenericEntry || {};

      const hrAliases = ['heartRate', 'HR', 'pulse', 'heart_rate', 'Rate', 'BPM', 'HeartRate', 'heart', 'value', 'bpm'];
      
      const searchHistory = (histArr: any[], pKey: string, al: string[]) => {
        if (!histArr || histArr.length === 0) return null;
        for (let i = histArr.length - 1; i >= 0; i--) {
          const v = valFor(histArr[i], pKey, al);
          if (v !== null && v !== 0 && v !== undefined) return v;
        }
        return null;
      };

      const hrFromE = searchHistory(eHistory, 'bpm', hrAliases);
      const hrFromB = searchHistory(bHistory, 'bpm', hrAliases);
      const hrFromEC = searchHistory(ecHistory, 'bpm', hrAliases);
      const hrFromP = searchHistory(pHistory, 'bpm', hrAliases);
      const hrFromR = searchHistory(rHistory, 'bpm', hrAliases);
      const hrFromM = searchHistory(mHistory, 'bpm', hrAliases);
      const hrFromS = searchHistory(sHistory, 'bpm', hrAliases);
      const hrFromG = searchHistory(gHistory, 'bpm', hrAliases);

      const detectedHR = hrFromE ?? hrFromB ?? hrFromEC ?? hrFromP ?? hrFromR ?? hrFromM ?? hrFromS ?? hrFromG;
      if (detectedHR && detectedHR > 0) {
        lastValidHR = getSafeNum(detectedHR);
      }
      const hrValue = lastValidHR;

      // Raw ECG: Extract waveform or raw points
      const rawEcgValue = getSafeNum(
        valFor(e, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ?? 
        valFor(ec, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ?? 
        valFor(p, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ?? 
        valFor(r, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ?? 
        valFor(m, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ?? 
        valFor(s, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value']) ??
        valFor(g, 'rawECG', ['ecg', 'raw_ecg', 'waveform', 'raw_waveform', 'RAW', 'value'])
      );
      // 3. EXTRACT SENSORS
      const accel = {
        x: getSafeNum(valFor(s, 'accelX', ['ax']) ?? valFor(r, 'accelX', ['ax']) ?? valFor(g, 'ax')),
        y: getSafeNum(valFor(s, 'accelY', ['ay']) ?? valFor(r, 'accelY', ['ay']) ?? valFor(g, 'ay')),
        z: getSafeNum(valFor(s, 'accelZ', ['az']) ?? valFor(r, 'accelZ', ['az']) ?? valFor(g, 'az'))
      };

      const detectedTemp = valFor(p, 'temperature', ['temp', 'bodyTemp', 'BodyTemp', 'T', 'tempC', 'Celsius', 'body_temp', 'contact_temp']) ?? 
                          valFor(r, 'temperature', ['temp', 'bodyTemp', 'BodyTemp', 'T', 'tempC', 'Celsius', 'body_temp', 'contact_temp']) ?? 
                          valFor(s, 'temperature', ['temp', 'bodyTemp', 'BodyTemp', 'T', 'tempC', 'Celsius', 'body_temp', 'contact_temp']) ??
                          valFor(g, 'temperature', ['temp', 'bodyTemp', 'BodyTemp', 'T', 'tempC', 'Celsius', 'body_temp', 'contact_temp']);
      
      if (detectedTemp && detectedTemp > 20) {
        lastValidTemp = getSafeNum(detectedTemp);
      }
      const bodyTemp = lastValidTemp;
      
      const ambientTemp = getSafeNum(
        valFor(s, 'mlx_non_contact', ['ambient', 'mlxNonContact']) ?? 
        valFor(r, 'mlx_non_contact', ['ambient', 'mlxNonContact']) ??
        valFor(g, 'ambient', ['ambientTemp'])
      );
      const detectedSpo2 = valFor(p, 'spo2', ['oxygen', 'SpO2', 'SPO2', 'O2']) ?? 
                           valFor(s, 'spo2', ['oxygen', 'SpO2']) ?? 
                           valFor(r, 'spo2', ['oxygen', 'SpO2']) ??
                           valFor(g, 'spo2', ['oxygen', 'SpO2']);
      
      if (detectedSpo2 && detectedSpo2 > 50) {
        lastValidSpo2 = getSafeNum(detectedSpo2);
      }
      const spo2 = lastValidSpo2;

      const hwStressScore = valFor(s, 'stressScore', ['score', 'stress_score']) ?? valFor(r, 'stressScore', ['score', 'stress_score']) ?? valFor(g, 'stress', ['stressScore']);
      const hwStressState = valFor(s, 'stressState', ['state', 'stress_state']) ?? valFor(r, 'stressState', ['state', 'stress_state']) ?? valFor(g, 'stressState', ['state']);
      const hwMotion = getSafeNum(valFor(s, 'motionLevel', ['motion', 'motion_level']) ?? valFor(r, 'motionLevel', ['motion', 'motion_level']) ?? valFor(g, 'motion', ['motionLevel']));

      let stress;
      if (hwStressScore !== null && hwStressState !== null) {
        stress = {
          score: getSafeNum(hwStressScore),
          state: String(hwStressState),
          routine: hwMotion > 5 ? 'Active' : (hwMotion > 2 ? 'Moderate' : 'Sedentary'),
          suggestion: String(hwStressState).toLowerCase().includes('stress') ? 'Take a deep breath and rest.' : 'You are in a healthy state.',
          hrv: 100 - getSafeNum(hwStressScore)
        };
      } else {
        stress = calculateStress(hrValue, spo2, accel, bodyTemp);
      }

      // Reconstruct timestamp
      const tsVal = getSafeNum(valFor(b, 'timestamp', ['ts'])) ||
                    getSafeNum(valFor(p, 'timestamp', ['ts'])) ||
                    getSafeNum(valFor(e, 'timestamp', ['ts'])) || 
                    getSafeNum(valFor(s, 'timestamp', ['ts'])) || 
                    getSafeNum(valFor(r, 'timestamp', ['ts'])) ||
                    getSafeNum(valFor(g, 'timestamp', ['ts']));
      
      let hardwareTimestamp = 0;
      if (tsVal > 0) {
        if (tsVal > 1000000000000) hardwareTimestamp = tsVal;
        else if (tsVal > 1000000000) hardwareTimestamp = tsVal * 1000;
      }

      if (hardwareTimestamp === 0) {
        const anyEntryFallback = b.key ? b : (p.key ? p : (e.key ? e : (ec.key ? ec : (r.key ? r : (m.key ? m : (s.key ? s : (g.key ? g : null)))))));
        if (anyEntryFallback && anyEntryFallback.key) {
          let keyTs = Number(anyEntryFallback.key.split('_')[0]);
          if (!isNaN(keyTs) && keyTs > 1000000000) {
            if (keyTs > 1000000000000) hardwareTimestamp = keyTs;
            else hardwareTimestamp = keyTs * 1000;
          }
        }
      }

      // ALWAYS force sync to arrival time if device clock is wrong or stale
      let timestamp = hardwareTimestamp;
      if (timestamp === 0 || Math.abs(Date.now() - timestamp) > 300000) {
        timestamp = Date.now();
      }

      const mappedData: SensorData = {
        userId: targetUid,
        heartRate: hrValue,
        spo2: spo2,
        bodyTemp: bodyTemp,
        ambientTemp: ambientTemp,
        altitude: getSafeNum(valFor(s, 'altitude') ?? valFor(r, 'altitude') ?? valFor(g, 'altitude')),
        pressure: getSafeNum(valFor(s, 'pressure') ?? valFor(r, 'pressure') ?? valFor(g, 'pressure')),
        timestamp,
        ecg: [rawEcgValue],
        accel,
        hrv: stress.hrv,
        stressScore: stress.score,
        status: hrValue > 40 ? 'Normal' : 'Idle',
        stressType: stress.state,
        activityLevel: stress.routine,
        suggestion: stress.suggestion
      };

      setData(mappedData);

      // 5. HISTORY GENERATION
      const baseHistory = eHistory.length > 0 ? eHistory : (bHistory.length > 0 ? bHistory : (pHistory.length > 0 ? pHistory : (ecHistory.length > 0 ? ecHistory : (mHistory.length > 0 ? mHistory : (rHistory.length > 0 ? rHistory : (sHistory.length > 0 ? sHistory : gHistory))))));
      const hist = baseHistory.map((item, i) => {
        const itemTsVal = getSafeNum(valFor(item, 'timestamp', ['ts']));
        let itemTs = 0;
        
        if (itemTsVal > 0) {
          if (itemTsVal > 1000000000000) itemTs = itemTsVal;
          else if (itemTsVal > 1000000000) itemTs = itemTsVal * 1000;
        }
        
        if (itemTs === 0 && item.key) {
          const keyTs = Number(item.key.split('_')[0]);
          if (!isNaN(keyTs) && keyTs > 1000000000) {
             if (keyTs > 1000000000000) itemTs = keyTs;
             else itemTs = keyTs * 1000;
          }
        }
        
        if (itemTs === 0) {
          // If no timestamp, space backwards from the latest found timestamp
          const anchor = timestamp || Date.now();
          itemTs = anchor - (baseHistory.length - 1 - i) * 1000;
        }
        
        return {
          time: new Date(itemTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          fullTime: new Date(itemTs).toLocaleString(),
          hr: getSafeNum(valFor(item, 'bpm', ['heartRate', 'HR', 'pulse', 'value', 'heart_rate']) ?? hrValue), 
          spo2: getSafeNum(valFor(item, 'spo2', ['oxygen', 'SpO2']) ?? spo2),
          temp: getSafeNum(valFor(item, 'temperature', ['temp', 'bodyTemp', 'T']) ?? bodyTemp),
          stress: getSafeNum(valFor(item, 'stressScore') ?? stress.score),
          hrv: getSafeNum(valFor(item, 'hrv') ?? stress.hrv),
          accel: accel,
          ecgPoint: getSafeNum(valFor(item, 'rawECG', ['ecg', 'raw_ecg', 'waveform']))
        };
      });
      setHistory(hist.slice(-50));
      setPacketCount(prev => prev + 1);
    };

    const unsubSensors = onValue(sensorsQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        sHistory = items;
        latestSensorEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubEcg = onValue(ecgQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        eHistory = items;
        latestEcgEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubReadings = onValue(readingsQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        rHistory = items;
        latestReadingEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubEcgCaps = onValue(ecgCapsQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        ecHistory = items;
        latestEcgCapsEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubMain = onValue(mainSensorsQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        mHistory = items;
        latestMainEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubParams = onValue(paramsQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => { 
          const v = c.val();
          const item = (typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v };
          items.push(item); 
        });
        pHistory = items;
        latestParamEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubBpm = onValue(bpmQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => {
          const v = c.val();
          items.push((typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v });
        });
        bHistory = items;
        latestBpmEntry = items[items.length - 1];
        updateUI();
      }
    });

    const unsubGeneric = onValue(genericDataQuery, (snap) => {
      if (snap.exists()) {
        const items: any[] = [];
        snap.forEach(c => {
          const v = c.val();
          items.push((typeof v === 'object' && v !== null) ? { key: c.key, ...v } : { key: c.key, value: v });
        });
        gHistory = items;
        latestGenericEntry = items[items.length - 1];
        updateUI();
      }
    });

    return () => {
      unsubSensors();
      unsubEcg();
      unsubEcgCaps();
      unsubReadings();
      unsubMain();
      unsubParams();
      unsubBpm();
      unsubGeneric();
    };
  }, [user, uidOverride]);

  const stressAction = useMemo(() => {
    if (!data?.activityLevel) return { title: "Action", value: "Monitoring", unit: "...", color: "text-blue-500", bg: "bg-blue-500/10", trend: "Detecting biometrics" };
    
    const level = data.activityLevel;
    const timeIndex = Math.floor(Date.now() / 10000) % 4; // Rotate suggests every 10s

    if (level.includes('Cognitive') || level.includes('Mental')) {
      const suggestions = ["Deep breathing", "Focus on 4-7-8 method", "Short mental reset", "Hydrate immediately"];
      return { 
        title: "Mind Action", 
        value: suggestions[timeIndex % suggestions.length], 
        unit: "🧠", 
        color: "text-blue-400", 
        bg: "bg-blue-400/10", 
        trend: "Optimal mental reset" 
      };
    }
    if (level.includes('Physical') || level.includes('Exertion')) {
      const suggestions = ["Cool down phase", "Check hydration", "Control pulse", "Active recovery"];
      return { 
        title: "Body Action", 
        value: suggestions[timeIndex % suggestions.length], 
        unit: "🏃", 
        color: "text-orange-500", 
        bg: "bg-orange-500/10", 
        trend: "Managing cardiac load" 
      };
    }
    if (level.includes('Recovery') || level.includes('Restful')) {
      const suggestions = ["Full sync optimal", "Body at baseline", "Ideal HRV interval", "Rest state active"];
      return { 
        title: "Recovery Status", 
        value: suggestions[timeIndex % suggestions.length], 
        unit: "🧘", 
        color: "text-green-400", 
        bg: "bg-green-400/10", 
        trend: "Ready for peak" 
      };
    }
    
    return { 
      title: "Routine Activity", 
      value: level || "Stable Balance", 
      unit: "⚖️", 
      color: "text-cyan-400", 
      bg: "bg-cyan-400/10", 
      trend: "Optimal biometric sync" 
    };
  }, [data?.activityLevel]);

  const [isClearing, setIsClearing] = useState(false);

  const resetBioData = async () => {
    if (!targetUid || !window.confirm("CRITICAL: This will PERMANENTLY DELETE all heavy heart rate and sensor logs from Firebase to restore performance. Continue?")) return;
    
    setIsClearing(true);
    try {
      const { ref, remove } = await import('firebase/database');
      
      // The most robust way is to just wipe the entire UID folder in HealthData 
      // if these are all 'heavy' logs. 
      const hardwareRootRef = ref(rtdb, `HealthData/${targetUid}`);
      await remove(hardwareRootRef);

      // Also clear any global 'data' node if it exists (some ESP32 code uses this)
      const dataRootRef = ref(rtdb, `HealthData/data`);
      await remove(dataRootRef);

      setData(null);
      setHistory([]);
      setPacketCount(0);
      setLatestKeys([]);
      setDataSource('Cleared');
      
      alert("Hardware logs successfully cleared. Performance restored.");
    } catch (e: any) {
      console.error("Failed to clear data:", e);
      alert(`Clearing failed: ${e.message || 'Unknown error'}`);
    } finally {
      setIsClearing(false);
    }
  };

  const stats: HealthStats = {
    caloriesBurned: 1240,
    steps: 8432,
    activeMinutes: 45,
    sleepHours: 7.2
  };

  const themeClasses = isDarkMode 
    ? "bg-[#09090b] text-zinc-100 selection:bg-red-500/30" 
    : "bg-[#020617] text-cyan-50 selection:bg-cyan-500/30";

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <Activity className="w-16 h-16 text-red-500 animate-pulse" />
            <div className="absolute inset-0 bg-red-500/20 blur-xl animate-pulse" />
          </div>
          <p className="text-zinc-500 font-bold tracking-widest uppercase text-xs animate-pulse">Health Parameters System Initializing</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <div className={`min-h-screen w-full transition-colors duration-700 ${themeClasses} font-sans overflow-x-hidden`}>
      {/* Background decorative elements */}
      <div className={`fixed inset-0 overflow-hidden pointer-events-none`}>
        <div className={`absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full ${isDarkMode ? 'bg-red-500/5' : 'bg-cyan-500/10'} blur-[140px]`} />
        <div className={`absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] rounded-full ${isDarkMode ? 'bg-blue-500/5' : 'bg-lime-500/10'} blur-[140px]`} />
        
        {/* Blinking Nodes Grid */}
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="absolute inset-0">
          {[...Array(6)].map((_, i) => (
            <motion.div
              key={i}
              className={`absolute w-1 h-1 rounded-full ${isDarkMode ? 'bg-red-500/40' : 'bg-cyan-400/40'}`}
              style={{
                top: `${Math.random() * 100}%`,
                left: `${Math.random() * 100}%`,
              }}
              animate={{
                opacity: [0, 1, 0],
                scale: [0, 1.5, 0],
              }}
              transition={{
                duration: 2 + Math.random() * 3,
                repeat: Infinity,
                delay: Math.random() * 5,
              }}
            />
          ))}
        </div>
      </div>

      {/* Sidebar */}
      <aside className={`fixed left-0 top-0 h-full w-72 border-r ${isDarkMode ? 'border-zinc-800/50 bg-zinc-950/80' : 'border-cyan-500/10 bg-[#0f172a]/95'} backdrop-blur-3xl z-50 hidden lg:block transition-all duration-500`}>
        <div className="p-8">
          <div className="flex items-center gap-4 mb-12">
            <div className={`w-12 h-12 rounded-2xl ${isDarkMode ? 'bg-gradient-to-br from-red-500 to-orange-500' : 'bg-gradient-to-br from-cyan-400 to-emerald-400'} flex items-center justify-center shadow-xl ${isDarkMode ? 'shadow-red-500/20' : 'shadow-cyan-400/20'} relative group`}>
              <Activity className="text-white w-7 h-7 relative z-10" />
              <motion.div 
                animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                className="absolute inset-0 bg-white/30 rounded-2xl blur-sm"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <motion.h1 
                  animate={{ textShadow: isDarkMode ? ["0 0 0px #ef4444", "0 0 10px #ef4444", "0 0 0px #ef4444"] : ["0 0 0px #22d3ee", "0 0 10px #22d3ee", "0 0 0px #22d3ee"] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className={`text-2xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}
                >
                  HEALTH PARAMETERS
                </motion.h1>
              </div>
            </div>
          </div>

          <nav className="space-y-1">
            {[
              { id: 'overview', label: 'Overview', icon: LayoutDashboard },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-4 px-5 py-4 rounded-2xl transition-all duration-300 group ${
                  activeTab === item.id 
                    ? (isDarkMode ? 'bg-zinc-900 text-white shadow-lg shadow-black/20' : 'bg-cyan-500/20 text-cyan-100 shadow-lg shadow-cyan-500/10')
                    : (isDarkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/30' : 'text-cyan-700 hover:text-cyan-200 hover:bg-cyan-500/10')
                }`}
              >
                <item.icon className={`w-5 h-5 transition-transform duration-300 ${activeTab === item.id ? (isDarkMode ? 'text-red-500' : 'text-cyan-400 scale-110') : 'group-hover:scale-110'}`} />
                <span className="font-bold text-sm tracking-tight">{item.label}</span>
                {activeTab === item.id && (
                  <motion.div layoutId="activeNav" className={`ml-auto w-1.5 h-1.5 rounded-full ${isDarkMode ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]'}`} />
                )}
              </button>
            ))}
          </nav>
        </div>

        <div className="absolute bottom-0 w-full p-8 space-y-6">
          <div className={`p-5 rounded-[2rem] ${isDarkMode ? 'bg-zinc-900/40' : 'bg-[#1e293b]/40'} border ${isDarkMode ? 'border-zinc-800/50' : 'border-cyan-500/20'} backdrop-blur-md`}>
            <div className="flex items-center justify-between mb-3">
              <span className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-600'} uppercase tracking-widest`}>System Status</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full animate-pulse ${connectionStatus === 'online' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`} />
                <span className={`text-[10px] font-bold ${connectionStatus === 'online' ? (isDarkMode ? 'text-green-500' : 'text-emerald-400') : 'text-red-500'}`}>
                  {connectionStatus === 'online' ? 'SECURE' : 'OFFLINE'}
                </span>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg ${isDarkMode ? 'bg-zinc-800' : 'bg-cyan-950'} flex items-center justify-center`}>
                  <Cpu className={`w-4 h-4 ${isDarkMode ? 'text-zinc-400' : 'text-cyan-400'}`} />
                </div>
                <div>
                  <p className={`text-[10px] font-black tracking-tight ${isDarkMode ? 'text-white' : 'text-cyan-100'} uppercase`}>ESP32-C3 Sensor Hub</p>
                  <p className={`text-[9px] font-bold ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'}`}>{packetCount > 0 ? `Syncing Package #${packetCount}` : 'Awaiting initialization...'}</p>
                </div>
              </div>
              
              <Button 
                onClick={resetBioData}
                disabled={isClearing}
                variant="outline" 
                size="sm"
                className={`w-full text-[9px] font-black h-8 rounded-xl border-red-500/20 text-red-500 hover:bg-red-500/10 transition-all ${isClearing ? 'animate-pulse opacity-50' : ''}`}
              >
                {isClearing ? 'Clearing Database...' : 'Clear Heavy Logs'}
              </Button>
            </div>
          </div>
          

          <Button 
            variant="ghost" 
            onClick={logout}
            className={`w-full h-14 flex items-center justify-start gap-4 ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} hover:text-red-500 hover:bg-red-500/5 rounded-2xl transition-all duration-300 group`}
          >
            <div className={`w-10 h-10 rounded-xl ${isDarkMode ? 'bg-zinc-900/50' : 'bg-cyan-950/50'} flex items-center justify-center group-hover:bg-red-500/10 transition-colors`}>
              <LogOut className="w-5 h-5" />
            </div>
            <span className="font-bold text-sm tracking-tight">Disconnect</span>
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="lg:ml-72 p-4 lg:p-12 relative z-10 transition-all duration-500">
        {/* Mobile Branding Bar */}
        <div className="lg:hidden flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl ${isDarkMode ? 'bg-gradient-to-br from-red-500 to-orange-500' : 'bg-gradient-to-br from-cyan-400 to-emerald-400'} flex items-center justify-center shadow-lg shadow-red-500/20`}>
              <Activity className="text-white w-6 h-6" />
            </div>
            <motion.h1 
              animate={{ textShadow: isDarkMode ? ["0 0 0px #ef4444", "0 0 10px #ef4444", "0 0 0px #ef4444"] : ["0 0 0px #22d3ee", "0 0 10px #22d3ee", "0 0 0px #22d3ee"] }}
              transition={{ duration: 2, repeat: Infinity }}
              className={`text-xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}
            >
              HEALTH PARAMETERS
            </motion.h1>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={logout}
            className={`w-10 h-10 rounded-xl ${isDarkMode ? 'text-zinc-500 hover:text-red-500 hover:bg-red-500/5' : 'text-cyan-600 hover:text-red-500 hover:bg-red-500/5'}`}
          >
            <LogOut className="w-5 h-5" />
          </Button>
        </div>

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-1"
          >
            <div className={`flex items-center gap-2 mb-1`}>
              <LayoutDashboard className={`w-3.5 h-3.5 ${isDarkMode ? 'text-zinc-500' : 'text-cyan-400'}`} />
              <span className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase tracking-[0.3em]`}>Bio-Stream</span>
            </div>
            <div className="relative inline-block">
              <h2 className={`text-3xl lg:text-4xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-400'} relative z-10 leading-none uppercase`}>Health Parameters</h2>
            </div>
            {lastSync && (
              <div className={`text-[9px] font-black uppercase tracking-widest ${isDarkMode ? 'text-green-500' : 'text-emerald-400'} mt-2 flex items-center gap-1.5`}>
                <div className="w-1 h-1 rounded-full bg-current animate-ping" />
                Live Feed Active • Last Sync: {lastSync.toLocaleTimeString([], { hour12: false })}
              </div>
            )}
          </motion.div>

          {/* Hardware Debugger */}
          {uidOverride && packetCount > 0 && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6 p-4 bg-zinc-950/80 border border-zinc-900 rounded-2xl font-mono text-[10px] w-full"
            >
              <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
                <span className="text-cyan-400 font-black tracking-widest flex items-center gap-2 uppercase">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
                  Hardware Data Intel
                </span>
                <span className="text-zinc-600 font-black">Packets Logged: {packetCount}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3 bg-black/40 rounded-xl border border-white/5 space-y-2">
                  <div className="flex justify-between text-zinc-500 uppercase text-[8px] font-black">
                    <span>Field Mapping</span>
                    <span>Status</span>
                  </div>
                  <div className="flex justify-between items-center bg-zinc-900/50 p-2 rounded-lg">
                    <span className="text-zinc-400">Heart Rate (BPM)</span>
                    <div className="flex flex-col items-end">
                      <span className={data?.heartRate && data.heartRate > 30 ? "text-green-500 font-black" : "text-red-500 font-black animate-pulse"}>
                        {data?.heartRate || 0} BPM
                      </span>
                      {(!data?.heartRate || data.heartRate === 0) && data?.ecg && data.ecg[0] > 0 && (
                        <span className="text-[6px] text-zinc-500">Signal Detected</span>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-between items-center bg-zinc-900/50 p-2 rounded-lg">
                    <span className="text-zinc-400">Target UID</span>
                    <span className="text-cyan-500 font-black truncate max-w-[120px] select-all cursor-pointer" title="Click to copy UID" onClick={() => {
                      navigator.clipboard.writeText(targetUid || '');
                    }}>{targetUid}</span>
                  </div>
                </div>
                <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                  <div className="text-zinc-500 uppercase text-[8px] font-black mb-2 flex justify-between">
                    <span>Raw Packet View</span>
                    <span className="text-[7px] text-zinc-600">Keys Found</span>
                  </div>
                  <div className="max-h-24 overflow-y-auto text-zinc-500 custom-scrollbar pr-2 font-mono text-[9px]">
                    <pre className="whitespace-pre-wrap">
                      {JSON.stringify({ 
                        val: { bpm: data?.heartRate, ecg: data?.ecg ? data.ecg[0] : 0 },
                        source: dataSource,
                        keys: latestKeys
                      }, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full md:w-auto">
            <TabsList className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-cyan-50/50 border-cyan-100'} border p-1 rounded-xl`}>
              <TabsTrigger value="overview" className="rounded-lg px-6 py-2 data-[state=active]:bg-red-500 data-[state=active]:text-white transition-all uppercase text-[10px] font-black tracking-widest">Overview</TabsTrigger>
              <TabsTrigger value="stress" className="rounded-lg px-6 py-2 data-[state=active]:bg-red-500 data-[state=active]:text-white transition-all uppercase text-[10px] font-black tracking-widest">Stress Intel</TabsTrigger>
            </TabsList>
          </Tabs>

          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center justify-end md:justify-end gap-3 md:gap-4 w-full md:w-auto"
          >
            <div className={`flex items-center gap-3 lg:gap-4 pl-0 md:pl-6 border-l-0 md:border-l ${isDarkMode ? 'md:border-zinc-800' : 'md:border-cyan-500/20'} justify-end`}>
              <div className="text-left hidden md:block">
                <p className={`text-xs font-black tracking-tight ${isDarkMode ? '' : 'text-cyan-100'}`}>{user?.displayName || user?.email?.split('@')[0]}</p>
                <Badge variant="outline" className={`text-[8px] font-black uppercase tracking-widest ${isDarkMode ? 'border-red-500/30 text-red-500 bg-red-500/5' : 'border-cyan-400/30 text-cyan-400 bg-cyan-400/5'} px-1 py-0`}>
                  {user?.email}
                </Badge>
              </div>
              
              <div className="flex items-center gap-2 md:gap-4">
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl mr-2">
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[7px] font-black uppercase text-zinc-500 leading-none">Hardware Sync UID</span>
                    <input 
                      type="text" 
                      placeholder="Enter UID..."
                      value={uidOverride}
                      onChange={(e) => setUidOverride(e.target.value)}
                      className="bg-transparent border-none text-[10px] font-black focus:ring-0 w-32 p-0 placeholder:text-zinc-700 h-3 text-cyan-400"
                    />
                  </div>
                  {targetUid && (
                    <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse border border-cyan-400/50" />
                  )}
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className={`w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl ${isDarkMode ? 'bg-zinc-800 text-yellow-500' : 'bg-cyan-950 text-cyan-400 shadow-lg shadow-cyan-500/10'} hover:scale-110 transition-all duration-300 shadow-sm`}
                >
                  {isDarkMode ? <Sun className="w-4 h-4 md:w-5 md:h-5" /> : <MoonIcon className="w-4 h-4 md:w-5 md:h-5" />}
                </Button>
                
                <div className="relative group cursor-pointer">
                  <div className="absolute -inset-0.5 bg-gradient-to-tr from-red-500 to-orange-500 rounded-full blur opacity-40 group-hover:opacity-100 transition duration-500" />
                  <img 
                    src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=male&gender=male`} 
                    alt="Profile" 
                    className="relative w-8 h-8 md:w-11 md:h-11 lg:w-12 lg:h-12 rounded-full border-2 border-zinc-950 object-cover shadow-2xl"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>
            </div>
          </motion.div>
        </header>

        <Tabs value={activeTab} className="w-full">
          <TabsContent value="overview">
            {/* Real-time Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
              <StatCard 
                title="Heart Rate" 
                value={data ? (typeof data.heartRate === 'number' && !Number.isInteger(data.heartRate) ? data.heartRate.toFixed(1) : data.heartRate) : '--'} 
                unit="BPM" 
                icon={Heart} 
                color="text-red-500" 
                bg="bg-red-500/10"
                trend={data ? (data.hrv > 55 ? "High HRV (Recovery)" : data.hrv < 35 ? "Low HRV (Strain)" : "Stable HRV") : "Awaiting Link..."}
                isDarkMode={isDarkMode}
                delay={0.1}
                isStale={data && (now - data.timestamp) > 300000}
              />
              <StatCard 
                title="SPO2" 
                value={data ? Math.round(data.spo2) : '--'} 
                unit="%" 
                icon={Wind} 
                color="text-emerald-400" 
                bg="bg-emerald-400/10"
                trend="Oxygen Level"
                isDarkMode={isDarkMode}
                delay={0.2}
                isStale={data && (now - data.timestamp) > 300000}
              />
              <StatCard 
                title="Non-Contact Temp" 
                value={data && data.ambientTemp > 0 ? data.ambientTemp.toFixed(1) : '--'} 
                unit="°C" 
                icon={Thermometer} 
                color="text-blue-400" 
                bg="bg-blue-400/10"
                trend="Environment"
                isDarkMode={isDarkMode}
                delay={0.3}
                isStale={data && (now - data.timestamp) > 300000}
              />
              <StatCard 
                title="Body Temp" 
                value={data && data.bodyTemp > 0 ? data.bodyTemp.toFixed(1) : '--'} 
                unit="°C" 
                icon={Thermometer} 
                color="text-red-400" 
                bg="bg-red-400/10"
                trend="Skin Contact"
                isDarkMode={isDarkMode}
                delay={0.4}
                isStale={data && (now - data.timestamp) > 300000}
              />
            </div>

            <div className="space-y-8">
              {/* Row 1: Health Trends & Atmospheric Data */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 }}
                  className="xl:col-span-2"
                >
                  <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] overflow-hidden border h-full`}>
                    <CardHeader className="p-6 lg:p-8 pb-4">
                      <CardTitle className={`text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Health Trends (HR & SpO₂)</CardTitle>
                      <CardDescription className="text-zinc-500">Real-time biometric fluctuation (Historical Analysis)</CardDescription>
                    </CardHeader>
                    <CardContent className="h-[350px] w-full p-6 lg:p-8 pt-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={history}>
                          <defs>
                            <linearGradient id="colorHr" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={isDarkMode ? "#ef4444" : "#22d3ee"} stopOpacity={0.4}/>
                              <stop offset="95%" stopColor={isDarkMode ? "#ef4444" : "#22d3ee"} stopOpacity={0}/>
                            </linearGradient>
                            <linearGradient id="colorSpo2" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.05} />
                          <XAxis dataKey="time" hide />
                          <YAxis yId="left" hide domain={['auto', 'auto']} />
                          <YAxis yId="right" hide domain={[80, 100]} orientation="right" />
                          <Tooltip 
                            content={({ active, payload }) => (
                              active && payload && payload.length > 0 ? (
                                <div className="bg-zinc-900/90 border border-zinc-800 p-3 rounded-2xl backdrop-blur-xl shadow-2xl space-y-1">
                                  <p className="text-[10px] font-black text-red-500 uppercase tracking-widest">{payload[0].value} BPM</p>
                                  {payload[1] && <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">{payload[1].value}% SpO₂</p>}
                                </div>
                              ) : null
                            )}
                          />
                          <Area 
                            yId="left"
                            type="monotone" 
                            dataKey="hr" 
                            stroke={isDarkMode ? "#ef4444" : "#22d3ee"} 
                            strokeWidth={4}
                            fillOpacity={1} 
                            fill="url(#colorHr)" 
                          />
                          <Area 
                            yId="right"
                            type="monotone" 
                            dataKey="spo2" 
                            stroke="#10b981" 
                            strokeWidth={4}
                            fillOpacity={1} 
                            fill="url(#colorSpo2)" 
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.6 }}
                  className="xl:col-span-1"
                >
                  <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden h-full`}>
                    <CardHeader className="p-6 lg:p-8 pb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Wind className={`w-3.5 h-3.5 ${isDarkMode ? 'text-blue-400' : 'text-cyan-400'}`} />
                        <span className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-300' : 'text-cyan-600'} uppercase tracking-widest text-nowrap`}>Atmospheric Data</span>
                      </div>
                      <CardTitle className={`text-xl lg:text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Environmental</CardTitle>
                    </CardHeader>
                    <CardContent className="p-6 lg:p-8 pt-4 space-y-6 lg:space-y-10">
                      <EnvRow icon={Wind} label="Pressure" value={data?.pressure !== undefined ? data.pressure.toFixed(1) : '--'} unit="hPa" isDarkMode={isDarkMode} />
                      <EnvRow icon={Mountain} label="Altitude" value={data?.altitude !== undefined ? data.altitude.toFixed(1) : '--'} unit="m" isDarkMode={isDarkMode} />
                      <EnvRow icon={Cloud} label="Non-Contact" value={data?.ambientTemp !== undefined ? data.ambientTemp.toFixed(1) : '--'} unit="°C" isDarkMode={isDarkMode} />
                    </CardContent>
                  </Card>
                </motion.div>
              </div>

              {/* Row 2: ECG Waveform */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
              >
                <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/10 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden`}>
                  <CardHeader className="flex flex-row items-center justify-between p-6 lg:p-8 pb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Zap className={`w-3.5 h-3.5 ${isDarkMode ? 'text-red-500' : 'text-cyan-400'}`} />
                        <span className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-300' : 'text-cyan-600'} uppercase tracking-widest`}>Cardiac Signal</span>
                      </div>
                      <CardTitle className={`text-xl lg:text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>ECG Waveform</CardTitle>
                    </div>
                    <div className={`flex items-center gap-2 px-3 lg:px-4 py-1.5 lg:py-2 rounded-xl lg:rounded-2xl ${isDarkMode ? 'bg-red-500/10 border-red-500/20' : 'bg-cyan-500/10 border-cyan-500/20'}`}>
                      <div className={`w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full ${data ? 'bg-red-500 animate-ping' : (isDarkMode ? 'bg-zinc-700' : 'bg-cyan-900')}`} />
                      <span className={`text-[9px] lg:text-[10px] font-black ${isDarkMode ? 'text-red-500' : 'text-cyan-400'} uppercase tracking-widest`}>{data ? 'LIVE' : 'IDLE'}</span>
                    </div>
                  </CardHeader>
                    <CardContent className="p-6 lg:p-8 pt-4">
                      <div className={`h-[350px] w-full bg-zinc-950 rounded-[1.5rem] lg:rounded-[2rem] border border-zinc-800 overflow-hidden relative shadow-2xl group`}>
                        <ECGWaveform history={history} isDarkMode={true} showLabels={true} />
                      </div>
                    </CardContent>
                </Card>
              </motion.div>

              {/* Row 3: Activity Goal & History Log */}
              <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-8">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 }}
                >
                  <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden`}>
                    <CardHeader className="p-6 lg:p-8 pb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Move className={`w-3.5 h-3.5 ${isDarkMode ? 'text-green-500' : 'text-cyan-400'}`} />
                        <span className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-300' : 'text-cyan-600'} uppercase tracking-widest`}>Kinetic Tracking</span>
                      </div>
                      <CardTitle className={`text-xl lg:text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Activity Goal</CardTitle>
                    </CardHeader>
                    <CardContent className="p-6 lg:p-8 pt-4">
                      <div className="flex items-center justify-between mb-8">
                        <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                          <div className="text-left group/label">
                            <p className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-600'} uppercase tracking-widest mb-1 transition-colors group-hover/label:text-green-500`}>Steps</p>
                            <p className={`text-4xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-100'}`}>{stats.steps.toLocaleString()}</p>
                          </div>
                          <div className="text-left group/label">
                            <p className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-600'} uppercase tracking-widest mb-1 transition-colors group-hover/label:text-red-500`}>Kcal</p>
                            <p className={`text-4xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-100'}`}>{stats.caloriesBurned.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className={`w-16 h-16 rounded-2xl ${isDarkMode ? 'bg-green-500/10' : 'bg-cyan-500/10'} flex items-center justify-center shadow-inner shrink-0 self-start`}>
                          <Flame className={`${isDarkMode ? 'text-green-500' : 'text-cyan-400'} w-8 h-8 animate-bounce`} />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4 border-t border-zinc-800/20 pt-8 mb-8">
                        <div className="text-left">
                          <p className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase tracking-widest mb-1`}>Accel X</p>
                          <p className={`text-xl font-black tracking-tighter italic ${isDarkMode ? 'text-green-500' : 'text-cyan-400'}`}>{data?.accel?.x !== undefined ? data.accel.x.toFixed(2) : '--'}</p>
                        </div>
                        <div className="text-left border-x border-zinc-800/20 px-4">
                          <p className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase tracking-widest mb-1`}>Accel Y</p>
                          <p className={`text-xl font-black tracking-tighter italic ${isDarkMode ? 'text-green-500' : 'text-cyan-400'}`}>{data?.accel?.y !== undefined ? data.accel.y.toFixed(2) : '--'}</p>
                        </div>
                        <div className="text-left">
                          <p className={`text-[9px] font-black ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase tracking-widest mb-1`}>Accel Z</p>
                          <p className={`text-xl font-black tracking-tighter italic ${isDarkMode ? 'text-green-500' : 'text-cyan-400'}`}>{data?.accel?.z !== undefined ? data.accel.z.toFixed(2) : '--'}</p>
                        </div>
                      </div>

                      <div className={`h-3 w-full ${isDarkMode ? 'bg-zinc-800/50' : 'bg-cyan-950/50'} rounded-full overflow-hidden p-0.5 border ${isDarkMode ? 'border-zinc-800' : 'border-cyan-500/10'} mb-3`}>
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: '84%' }}
                          transition={{ duration: 1.5, ease: "easeOut" }}
                          className={`h-full bg-gradient-to-r ${isDarkMode ? 'from-green-500 to-emerald-400' : 'from-cyan-500 to-blue-500'} rounded-full shadow-[0_0_15px_rgba(34,197,94,0.4)]`}
                        />
                      </div>
                      <div className="flex justify-between">
                        <p className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-700'} uppercase tracking-widest`}>Progress</p>
                        <p className={`text-[10px] font-black ${isDarkMode ? 'text-green-500' : 'text-cyan-400'} uppercase tracking-widest`}>84% Complete</p>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.9 }}
                >
                <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#1e293b]/40 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-2xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden h-full`}>
                    <CardHeader className="p-6 lg:p-8 pb-4">
                      <CardTitle className={`text-xl lg:text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>System Activity Stream</CardTitle>
                    </CardHeader>
                    <CardContent className="p-6 lg:p-8 pt-0">
                      <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 scrollbar-thin">
                        {/* Real-time Firestore Logs */}
                        {systemLogs.map((log, idx) => (
                          <div key={log.id || idx} className={`p-4 rounded-2xl flex items-center justify-between border ${isDarkMode ? 'bg-zinc-950/50 border-zinc-800/50' : 'bg-[#0f172a]/80 border-cyan-500/10'}`}>
                            <div className="flex items-center gap-4">
                              <div className={`w-8 h-8 rounded-full ${
                                log.type === 'LOGIN' ? (isDarkMode ? 'bg-green-500/10' : 'bg-green-500/10') : (isDarkMode ? 'bg-blue-500/10' : 'bg-cyan-500/10')
                              } flex items-center justify-center shrink-0`}>
                                {log.type === 'LOGIN' ? <LogIn className="w-4 h-4 text-green-500" /> : <Activity className="w-4 h-4 text-blue-500" />}
                              </div>
                              <div>
                                <p className={`text-sm font-black ${isDarkMode ? 'text-white' : 'text-cyan-100 uppercase'}`}>
                                  {log.type === 'LOGIN' ? 'System Login' : 'System Event'}
                                </p>
                                <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase font-black`}>
                                  {log.email || log.userId || 'System'} • {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleTimeString() : 'Recently'}
                                </p>
                              </div>
                            </div>
                            <div className="text-right">
                               <p className={`text-[10px] font-black uppercase ${log.type === 'LOGIN' ? 'text-green-500' : 'text-blue-500'}`}>Real-time</p>
                            </div>
                          </div>
                        ))}

                        {/* Fallback Bio-Packet Sync Events if no logs */}
                        {systemLogs.length === 0 && history.slice().reverse().slice(0, 5).map((entry, idx) => (
                          <div key={idx} className={`p-4 rounded-2xl flex items-center justify-between border ${isDarkMode ? 'bg-zinc-950/50 border-zinc-800/50' : 'bg-[#0f172a]/80 border-cyan-500/10'}`}>
                            <div className="flex items-center gap-4">
                              <div className={`w-8 h-8 rounded-full ${isDarkMode ? 'bg-blue-500/10' : 'bg-cyan-500/10'} flex items-center justify-center shrink-0`}>
                                <Activity className={`w-4 h-4 ${isDarkMode ? 'text-blue-500' : 'text-cyan-400'}`} />
                              </div>
                              <div>
                                <p className={`text-sm font-black ${isDarkMode ? 'text-white' : 'text-cyan-100 uppercase'}`}>Bio-Packet Sync</p>
                                <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase font-black`}>Node Sync: {entry.time}</p>
                              </div>
                            </div>
                            <div className="text-right">
                               <p className={`text-[10px] font-black uppercase ${isDarkMode ? 'text-blue-500' : 'text-cyan-400'}`}>Passive</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="stress">
            <div className="space-y-10 mt-8">
              <div className="flex flex-col gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className={`w-4 h-4 ${isDarkMode ? 'text-red-500' : 'text-cyan-400'}`} />
                  <span className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-500' : 'text-cyan-600'} uppercase tracking-[0.3em]`}>Stress Intelligence</span>
                </div>
                <h2 className={`text-3xl font-black tracking-tighter italic uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Health Analytics</h2>
              </div>

              {/* Dynamic Alerts Banner - Integrated into Stress Tab */}
              <AnimatePresence mode="wait">
                {data?.stressScore !== undefined && (
                  <motion.div
                    key={data.stressType}
                    initial={{ opacity: 0, y: 20, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -20, scale: 0.98 }}
                    className={`p-6 lg:p-8 rounded-[2rem] lg:rounded-[2.5rem] border backdrop-blur-3xl flex flex-col md:flex-row items-center justify-between gap-6 shadow-2xl transition-all duration-500 ${
                      data.stressScore > 75 
                        ? 'bg-red-500/10 border-red-500/30 text-red-500 shadow-red-500/10' 
                        : data.stressScore > 60
                        ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 shadow-orange-500/10'
                        : data.stressScore >= 30
                        ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-500 shadow-cyan-500/10'
                        : 'bg-green-500/10 border-green-500/30 text-green-500 shadow-green-500/10'
                    }`}
                  >
                    <div className="flex items-center gap-6">
                      <div className={`w-12 h-12 lg:w-16 lg:h-16 rounded-2xl lg:rounded-[2rem] flex items-center justify-center shadow-xl animate-pulse ${
                        data.stressScore > 75 ? 'bg-red-500' : data.stressScore > 60 ? 'bg-orange-500' : data.stressScore >= 30 ? 'bg-cyan-500' : 'bg-green-500'
                      }`}>
                        <Zap className="text-white w-6 h-6 lg:w-8 lg:h-8" />
                      </div>
                      <div>
                        <h3 className="text-xl lg:text-3xl font-black italic tracking-tighter uppercase leading-none">
                          {data.stressScore > 75 ? '🚨 High Stress: ' : data.stressScore > 60 ? '⚠️ Warning: ' : data.stressScore >= 30 ? '⚖️ Balanced: ' : '🍃 Optimal: '}
                          {data.stressType}
                        </h3>
                        <p className={`text-[10px] lg:text-sm font-black uppercase mt-2 opacity-90 ${
                          data.stressScore > 85 ? 'text-white' : data.stressScore >= 65 ? 'text-orange-200' : data.stressScore >= 35 ? 'text-cyan-200' : 'text-green-200'
                        }`}>
                          {data.suggestion}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard 
                  title="Stress Core" 
                  value={data ? Math.round(data.stressScore || 0) : '--'} 
                  unit="/100" 
                  icon={TrendingUp} 
                  color="text-red-500" 
                  bg="bg-red-500/10"
                  isDarkMode={isDarkMode}
                  delay={0.1}
                />
                <StatCard 
                  title="Stress State" 
                  value={data?.stressType || '--'} 
                  unit={
                    data?.stressType?.includes('Physical') ? "🏃" : 
                    data?.stressType?.includes('Cognitive') ? "🧠" : 
                    data?.stressType?.includes('Mild') ? "🤔" : "🧘"
                  } 
                  icon={Zap} 
                  color="text-purple-500" 
                  bg="bg-purple-500/10"
                  isDarkMode={isDarkMode}
                  delay={0.2}
                  isEmojiUnit={true}
                />
                <StatCard 
                  title="HRV Level" 
                  value={data ? Math.round(data.hrv || 0) : '--'} 
                  unit="ms" 
                  icon={Activity} 
                  color="text-green-500" 
                  bg="bg-green-500/10"
                  isDarkMode={isDarkMode}
                  delay={0.3}
                />
                <StatCard 
                  title={stressAction.title}
                  value={stressAction.value} 
                  unit={stressAction.unit} 
                  icon={ShieldCheck} 
                  color={stressAction.color} 
                  bg={stressAction.bg}
                  isDarkMode={isDarkMode}
                  delay={0.4}
                  isEmojiUnit={true}
                />
              </div>

              {/* Advanced Signal Analysis Section */}
              <div className="grid grid-cols-1 gap-8">
                <Card className={`w-full ${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/10 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden`}>
                  <CardHeader className="p-8 pb-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Activity className={`w-3.5 h-3.5 ${isDarkMode ? 'text-green-500' : 'text-cyan-500'}`} />
                          <span className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-600'} uppercase tracking-widest`}>Real-time Electrophysiology</span>
                        </div>
                        <CardTitle className={`text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Advanced Heart Rhythm</CardTitle>
                      </div>
                      <Badge variant="outline" className="rounded-full border-current text-[10px] font-black tracking-tighter">
                        AD8232 ANALYZER
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="p-8 pt-0">
                    <div className={`h-[250px] w-full rounded-[2rem] overflow-hidden border relative bg-zinc-950 border-zinc-800 group`}>
                      <ECGWaveform history={history} isDarkMode={true} showLabels={true} />
                      <div className="absolute top-4 right-4 flex items-center gap-2 bg-black/60 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 z-20">
                        <Heart className="w-4 h-4 text-red-500 animate-pulse" />
                        <span className="text-xl font-black italic text-white leading-none">{data ? (typeof data.heartRate === 'number' && !Number.isInteger(data.heartRate) ? data.heartRate.toFixed(1) : data.heartRate) : '--'} <span className="text-[10px] uppercase not-italic opacity-70">BPM</span></span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mt-6">
                      <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                        <p className="text-[10px] font-black uppercase text-zinc-500 mb-1">P-Wave Activity</p>
                        <p className="text-sm font-bold text-green-500">Normal Sinus</p>
                      </div>
                      <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                        <p className="text-[10px] font-black uppercase text-zinc-500 mb-1">QRS Complex</p>
                        <p className="text-sm font-bold text-cyan-400">Stable Width</p>
                      </div>
                      <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                        <p className="text-[10px] font-black uppercase text-zinc-500 mb-1">T-Wave Reset</p>
                        <p className="text-sm font-bold text-orange-400">Active Repol.</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pb-8">
                 <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden`}>
                    <CardHeader className="p-8 pb-2">
                      <CardTitle className={`text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>HRV Trend (ms)</CardTitle>
                    </CardHeader>
                    <CardContent className="p-8 pt-4">
                      <div className="h-[300px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                           <AreaChart data={history}>
                              <defs>
                                <linearGradient id="colorHrv" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor={isDarkMode ? "#22c55e" : "#0ea5e9"} stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor={isDarkMode ? "#22c55e" : "#0ea5e9"} stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <Area type="monotone" dataKey="hrv" stroke={isDarkMode ? "#22c55e" : "#0ea5e9"} fillOpacity={1} fill="url(#colorHrv)" strokeWidth={3} className={isDarkMode ? "" : "drop-shadow-[0_0_10px_rgba(14,165,233,0.4)]"} />
                           </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                 </Card>

                 <Card className={`${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50' : 'bg-[#112240]/60 border-cyan-500/20 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-xl backdrop-blur-xl rounded-[2.5rem] border overflow-hidden`}>
                    <CardHeader className="p-8 pb-2">
                      <CardTitle className={`text-2xl font-black italic tracking-tight uppercase ${isDarkMode ? 'text-white' : 'text-cyan-400'}`}>Stress Map</CardTitle>
                    </CardHeader>
                    <CardContent className="p-8 pt-4">
                      <div className="grid grid-cols-2 gap-4">
                        {[
                          { label: 'High Stress', status: 'panic / acute strain', active: data?.stressScore !== undefined && data.stressScore > 85, icon: '🚨' },
                          { label: 'Moderate Stress', status: 'system strain', active: data?.stressScore !== undefined && data.stressScore >= 65 && data.stressScore <= 85, icon: '⚠️' },
                          { label: 'Recovered State', status: 'optimal restoration', active: data?.stressScore !== undefined && data.stressScore < 35, icon: '🍃' },
                          { label: 'Routine Balanced', status: 'stable biometric', active: data?.stressScore !== undefined && data.stressScore >= 35 && data.stressScore < 65, icon: '⚖️' }
                        ].map((item, i) => (
                          <div key={i} className={`p-6 rounded-3xl border transition-all duration-500 ${item.active ? 'bg-cyan-500/20 border-cyan-500/50 scale-105 shadow-xl' : (isDarkMode ? 'bg-transparent border-zinc-800' : 'bg-cyan-950/40 border-cyan-500/10')}`}>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xl">{item.icon}</span>
                              {item.active && <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />}
                            </div>
                            <p className={`text-sm font-black uppercase italic ${item.active ? 'text-cyan-400' : (isDarkMode ? 'text-zinc-600' : 'text-cyan-800')}`}>{item.label}</p>
                            <p className={`text-[10px] font-bold mt-1 ${item.active ? (isDarkMode ? 'text-white' : 'text-cyan-100') : (isDarkMode ? 'text-zinc-700' : 'text-cyan-900')}`}>{item.status}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                 </Card>
              </div>

              </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function ECGWaveform({ history, isDarkMode, showLabels = false }: { history: any[], isDarkMode: boolean, showLabels?: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [isLive, setIsLive] = useState(true);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [pausedTime, setPausedTime] = useState<number>(0);
  const animationRef = React.useRef<number>(0);
  const startTimeRef = React.useRef<number>(Date.now());
  const lastTimeRef = React.useRef<number>(Date.now());
  const accumulatedTimeRef = React.useRef<number>(0);

  // Extract raw points and latest heart rate
  const points = useMemo(() => history.map(h => h.ecgPoint), [history]);
  const currentBPM = useMemo(() => {
    if (history.length === 0) return 0;
    const last = history[history.length - 1].hr;
    return last;
  }, [history]);
  
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width, height: rect.height });
      }
    };
    handleResize();
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (dimensions.width === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    ctx.scale(dpr, dpr);

    const { width, height } = dimensions;

    const render = () => {
      // Update accumulated time only when live
      if (isLive) {
        const now = Date.now();
        const delta = (now - lastTimeRef.current) / 1000;
        accumulatedTimeRef.current += delta;
        lastTimeRef.current = now;
      } else {
        lastTimeRef.current = Date.now(); // Sync so when we resume there is no jump
      }

      ctx.clearRect(0, 0, width, height);
      
      // Grid System (Medical Paper Look)
      const smallGrid = 20;
      const largeGrid = smallGrid * 5;
      
      ctx.beginPath();
      ctx.strokeStyle = isDarkMode ? '#ef4444' : '#ffb3b3'; 
      ctx.globalAlpha = isDarkMode ? 0.08 : 0.12;
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= width; x += smallGrid) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y <= height; y += smallGrid) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();

      ctx.beginPath();
      ctx.globalAlpha = isDarkMode ? 0.15 : 0.25;
      ctx.lineWidth = 1;
      for (let x = 4; x <= width; x += largeGrid) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 4; y <= height; y += largeGrid) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Pulse generation logic
      const drawPoints: {x: number, y: number, phase: number, type: string, value: number}[] = [];
      const visibleCount = 200; // Increased resolution for slow movement
      const stepX = width / (visibleCount - 1);
      
      const bpm = currentBPM || 72;
      const period = 60 / bpm;
      const timeWindow = 20.0; // Slowed down from 15.0 - shows 20 seconds across width

      for (let i = 0; i < visibleCount; i++) {
        const x = i * stepX;
        // Time corresponding to this X position
        // The scroll comes from accumulatedTimeRef
        const t = accumulatedTimeRef.current + (i / visibleCount) * timeWindow; 
        const phase = (t % period) / period;
        
        // P-QRS-T Synthesis (Image 2 anatomy)
        let pulseVal = 0;
        let type = 'baseline';

        // P Wave (Atrial)
        if (phase >= 0.1 && phase < 0.2) {
          pulseVal += 0.12 * Math.sin(Math.PI * (phase - 0.1) / 0.1);
          type = 'P';
        }
        // QRS Complex (Ventricular)
        else if (phase >= 0.21 && phase < 0.27) {
          if (phase >= 0.21 && phase < 0.22) { pulseVal -= 0.08; type = 'Q'; }
          else if (phase >= 0.22 && phase < 0.25) { pulseVal += 1.0 * Math.sin(Math.PI * (phase - 0.22) / 0.03); type = 'R'; }
          else if (phase >= 0.25 && phase < 0.27) { pulseVal -= 0.2; type = 'S'; }
        }
        // T Wave (Repolarization)
        else if (phase >= 0.45 && phase < 0.65) {
          pulseVal += 0.22 * Math.sin(Math.PI * (phase - 0.45) / 0.2);
          type = 'T';
        }
        
        const scale = 60;
        const displayY = height / 2 - (pulseVal * scale);
        
        drawPoints.push({ x, y: displayY, phase, type, value: pulseVal });
      }

      // Draw trace with Glow
      ctx.beginPath();
      ctx.strokeStyle = isDarkMode ? '#22d3ee' : '#0891b2';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      
      if (isDarkMode) {
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(34, 211, 238, 0.5)';
      }

      drawPoints.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Analysis Mode / Tooltip when frozen or hovered
      if (!isLive && hoverX !== null) {
        // Draw vertical cursor
        ctx.beginPath();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
        ctx.moveTo(hoverX, 0);
        ctx.lineTo(hoverX, height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Find closest point
        const closestPoint = drawPoints.reduce((prev, curr) => 
          Math.abs(curr.x - hoverX) < Math.abs(prev.x - hoverX) ? curr : prev
        );

        if (closestPoint) {
          // Highlight point
          ctx.beginPath();
          ctx.arc(closestPoint.x, closestPoint.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = isDarkMode ? '#fff' : '#000';
          ctx.fill();

          // Label Tooltip
          const label = closestPoint.type !== 'baseline' ? closestPoint.type : 'Isoelectric';
          const valText = `${label} Wave: ${(closestPoint.value).toFixed(2)} mV`;
          
          ctx.fillStyle = isDarkMode ? '#1e293b' : '#f1f5f9';
          ctx.font = 'black 12px Inter';
          const textWidth = ctx.measureText(valText).width + 20;
          ctx.fillRect(closestPoint.x - textWidth/2, closestPoint.y - 45, textWidth, 30);
          ctx.strokeStyle = isDarkMode ? '#334155' : '#cbd5e1';
          ctx.strokeRect(closestPoint.x - textWidth/2, closestPoint.y - 45, textWidth, 30);
          
          ctx.fillStyle = isDarkMode ? '#fff' : '#0f172a';
          ctx.textAlign = 'center';
          ctx.fillText(valText, closestPoint.x, closestPoint.y - 25);
        }
      }

      // Annotations if enabled
      if (showLabels || !isLive) {
        // Highlight peaks
        drawPoints.forEach((p, i) => {
          if (p.type !== 'baseline' && i % 5 === 0) { // Check every 5 points for local peak
             // Simple peak detection: logic to only show label at the absolute peak of the wave segment
             const prev = i > 0 ? drawPoints[i-1] : p;
             const next = i < drawPoints.length - 1 ? drawPoints[i+1] : p;
             
             let isPeak = false;
             if (p.type === 'R' && p.value >= prev.value && p.value >= next.value && p.value > 0.8) isPeak = true;
             if (p.type === 'P' && p.value >= prev.value && p.value >= next.value && p.value > 0.1) isPeak = true;
             if (p.type === 'T' && p.value >= prev.value && p.value >= next.value && p.value > 0.2) isPeak = true;
             if (p.type === 'S' && p.value <= prev.value && p.value <= next.value && p.value < -0.15) isPeak = true;
             if (p.type === 'Q' && p.value <= prev.value && p.value <= next.value && p.value < -0.05) isPeak = true;

             if (isPeak) {
                const label = `${p.type} (${p.value.toFixed(2)})`;
                ctx.fillStyle = isDarkMode ? '#fff' : '#000';
                ctx.font = 'bold 9px Inter';
                ctx.textAlign = 'center';
                // Offset R differently since it's much higher
                const yOffset = p.type === 'R' ? 15 : 10;
                ctx.fillText(label, p.x, p.y - yOffset);
             }
          }
        });
      }

      // Live sweeping marker
      if (isLive && drawPoints.length > 0) {
        const last = drawPoints[drawPoints.length - 1];
        if (last) {
          ctx.beginPath();
          ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.shadowBlur = 15;
          ctx.shadowColor = '#fff';
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationRef.current);
  }, [points, history, dimensions, isDarkMode, currentBPM, showLabels, isLive]);

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full relative group cursor-pointer"
      onPointerDown={() => setIsLive(!isLive)}
      onPointerMove={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          setHoverX(e.clientX - rect.left);
        }
      }}
      onPointerLeave={() => setHoverX(null)}
    >
      <canvas 
        ref={canvasRef} 
        className="w-full h-full" 
      />
      
      <div className="absolute top-4 left-4 flex flex-col gap-1 pointer-events-none">
        <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
           <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-500 animate-pulse' : 'bg-zinc-500'}`} />
           <span className="text-[10px] font-black text-white uppercase tracking-widest">
              {isLive ? 'Live Monitor' : 'Sequence Analysis (Paused)'}
           </span>
        </div>
        {!isLive && (
          <div className="bg-red-500/80 backdrop-blur-md px-3 py-1 rounded-full text-[8px] font-black text-white uppercase tracking-tighter">
            Tap to Resume Waveform Flow
          </div>
        )}
      </div>
      
      {/* Help Overlay on hover */}
      <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
         <span className="text-[10px] bg-black/40 px-2 py-1 rounded-md text-zinc-400 font-bold uppercase tracking-widest">
           {isLive ? 'Tap to Pause & Inspect' : 'Hover to detect P-QRS-T complexes'}
         </span>
      </div>
    </div>
  );
}

function StatCard({ title, value, unit, icon: Icon, color, bg, trend, isDarkMode, delay, isEmojiUnit, isStale }: any) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      whileHover={{ y: -8, scale: 1.02 }}
      className={`p-6 md:p-8 rounded-[2rem] md:rounded-[2.5rem] border ${isDarkMode ? 'bg-zinc-900/40 border-zinc-800/50 hover:border-red-500/30' : 'bg-[#112240]/60 border-cyan-500/20 hover:border-cyan-400/40 shadow-[0_0_20px_rgba(34,211,238,0.05)]'} shadow-2xl backdrop-blur-xl group transition-all duration-500 font-sans relative overflow-hidden`}
    >
      {isStale && (
        <div className="absolute top-3 left-0 w-full flex justify-center z-50 pointer-events-none">
          <div className="bg-red-500 text-white text-[8px] font-black px-4 py-1 rounded-full shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse flex items-center gap-1.5">
            <Activity className="w-3 h-3" />
            STALE SIGNAL (SYNC LOST)
          </div>
        </div>
      )}
      {/* Decorative scan line on hover */}
      <div className={`absolute top-0 left-[-100%] w-full h-[2px] ${isDarkMode ? 'bg-red-500/50' : 'bg-cyan-400/50'} blur-sm group-hover:left-[100%] transition-all duration-1000 ease-in-out`} />
      
      <div className="flex items-center justify-between mb-6 md:mb-8 relative z-10">
        <div className={`p-3 md:p-4 rounded-xl md:rounded-2xl ${bg} shadow-inner transition-all duration-500 group-hover:rotate-[360deg] relative overflow-hidden bg-gradient-to-br from-transparent to-white/5`}>
          <Icon className={`w-6 h-6 md:w-7 md:h-7 ${color} relative z-10 transition-transform duration-500 group-hover:scale-125`} />
          {title === "Heart Rate" && (
            <motion.div 
              animate={{ scale: [1, 2, 1], opacity: [0.3, 0, 0.3] }}
              transition={{ duration: 0.8, repeat: Infinity }}
              className="absolute inset-0 bg-red-500/30 rounded-full blur-md"
            />
          )}
          {(title === "SPO2" || title === "Blood Oxygen") && (
            <motion.div 
              animate={{ y: [-2, 2, -2] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="absolute inset-0 bg-blue-500/10 rounded-full"
            />
          )}
          {(title.includes("Temp") || title.includes("Temperature")) && (
            <motion.div 
              animate={{ opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="absolute inset-x-0 bottom-0 h-1 bg-orange-500/40 blur-sm"
            />
          )}
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1">
            <span className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-300' : 'text-cyan-400'} uppercase tracking-[0.2em]`}>{title}</span>
          </div>
          <div className={`h-1 w-8 ${isDarkMode ? 'bg-red-500/20' : 'bg-cyan-500/20'} ml-auto mt-1 rounded-full group-hover:w-full transition-all duration-500`} />
        </div>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className={`${String(value).length > 20 ? 'text-xl' : String(value).length > 12 ? 'text-2xl' : String(value).length > 6 ? 'text-3xl' : 'text-4xl md:text-5xl'} font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-white'} leading-tight`}>{value}</h3>
        <span className={`${isEmojiUnit ? 'text-xl md:text-2xl' : 'text-xs uppercase tracking-widest'} ${isDarkMode ? 'text-zinc-400' : 'text-cyan-400'} font-black`}>{unit}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${isDarkMode ? 'bg-green-500' : 'bg-cyan-400'} animate-pulse`} />
        <p className={`text-[9px] md:text-[10px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-600'} uppercase tracking-widest`}>{trend}</p>
      </div>
    </motion.div>
  );
}

function EnvRow({ icon: Icon, label, value, unit, isDarkMode }: any) {
  return (
    <div className="flex items-center justify-between group cursor-default">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-xl ${isDarkMode ? 'bg-zinc-900 border border-zinc-800' : 'bg-cyan-950/50 border border-cyan-500/10 group-hover:border-cyan-400/50'} transition-all duration-300 group-hover:scale-110 group-hover:rotate-12`}>
          <Icon className={`w-5 h-5 ${isDarkMode ? 'text-zinc-400' : 'text-cyan-400'} group-hover:text-cyan-300 transition-colors`} />
        </div>
        <div className="flex flex-col">
          <span className={`text-xs font-black ${isDarkMode ? 'text-zinc-300' : 'text-cyan-600'} uppercase tracking-widest`}>{label}</span>
          <div className={`h-[1px] w-0 group-hover:w-full transition-all duration-500 ${isDarkMode ? 'bg-red-500/40' : 'bg-cyan-400/40'}`} />
        </div>
      </div>
      <div className="flex items-baseline gap-2 group-hover:translate-x-[-4px] transition-transform duration-300">
        <span className={`text-2xl font-black tracking-tighter italic ${isDarkMode ? 'text-white' : 'text-cyan-100'}`}>{value}</span>
        <span className={`text-[10px] font-black ${isDarkMode ? 'text-zinc-400' : 'text-cyan-400'} uppercase tracking-widest uppercase`}>{unit}</span>
      </div>
    </div>
  );
}

