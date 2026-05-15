export interface SensorData {
  userId?: string;
  heartRate: number;
  spo2: number;
  bodyTemp: number;
  ambientTemp?: number;
  pressure: number;
  altitude: number;
  accel?: { x: number; y: number; z: number };
  gyro?: { x: number; y: number; z: number };
  ecg?: number[];
  stressLevel?: 'High' | 'Medium' | 'Low';
  hrv?: number;
  stressScore?: number;
  stressType?: string;
  activityLevel?: string;
  suggestion?: string;
  status?: string;
  timestamp: number;
}

export interface HealthStats {
  caloriesBurned: number;
  steps: number;
  activeMinutes: number;
  sleepHours: number;
}
