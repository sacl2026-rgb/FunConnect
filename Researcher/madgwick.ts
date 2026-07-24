// Madgwick AHRS — server-side sensor fusion for CyberPi disturbance alerts
//
// Pure function. No Worker bindings, no D1, no side effects.
// Edge imports this, calls it synchronously in webSocketMessage(), stores the
// returned plain object as JSON in D1.
//
// Input:  75 × 6 ring buffer  [ax, ay, az, gx, gy, gz]
//         accel in g (9.81 m/s² per unit), gyro in °/s (CyberPiOS get_gyro)
// Output:  { a_trans, roll, pitch, freefall, classification }
//
// Adaptive β (Jansen et al. 2021):
//   β = 0.96  when | |a| − 1 | < 0.15g AND |ω| < 0.5 rad/s  (clean — trust accel)
//   β = 0.0015 otherwise                                        (contaminated — trust gyro)
//
// Proven: ~5 ms in V8 for 75 samples at 25 Hz (Δt = 40 ms).

const DT = 0.04;               // 25 Hz = 40 ms per sample
const D2R = Math.PI / 180;      // °/s → rad/s (CyberPiOS gyro convention)
const BETA_CLEAN = 0.96;        // quiescent — fast gyro drift correction
const BETA_CONTAMINATED = 0.0015; // disturbance — nearly gyro-only
const FREEFALL_THRESHOLD = 0.35; // |a_raw| below this → freefall (g)
const FREEFALL_MIN_SAMPLES = 4;  // consecutive samples for true freefall
const STATIONARY_OMEGA = 0.5;    // rad/s — below this, device is "still"

// ── Output type ──────────────────────────────────────────────────────────────

export interface MadgwickOutput {
  a_trans: { x: number; y: number; z: number };  // translational accel at peak (g)
  roll: number;                                   // degrees at end of window
  pitch: number;                                  // degrees at end of window
  freefall: boolean;                              // ≥4 consecutive samples < 0.35g
  classification: "crash" | "bump" | "tilt" | "freefall" | "vibration" | "unknown";
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function madgwick(samples: number[][]): MadgwickOutput {
  // Quaternion state
  let q0 = 1, q1 = 0, q2 = 0, q3 = 0;

  // Accumulators over the window
  let maxATransMag = 0;
  let aTransAtPeak: [number, number, number] = [0, 0, 0];
  let maxOmega = 0;
  let rollEnd = 0, pitchEnd = 0;
  let sumATransMag = 0;
  let sumATransMagSq = 0;
  let sumOmega = 0;
  let freefallCount = 0;
  let maxFreefallRun = 0;
  let rollStart = 0, pitchStart = 0;
  let count = 0;
  let samplesBeforeEvent = 0;   // samples with low omega at start
  const omegaHistory: number[] = [];

  // First pass — Madgwick filter over every sample
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || s.length < 6) continue;
    let [ax, ay, az, gx, gy, gz] = s;

    // Convert gyro from °/s to rad/s
    gx *= D2R; gy *= D2R; gz *= D2R;

    // Raw magnitude for freefall check and β switching
    const rawMag = Math.sqrt(ax * ax + ay * ay + az * az);
    const omegaMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
    omegaHistory.push(omegaMag);

    // ── Adaptive β gating ─────────────────────────────────────────────────
    // Clean: accel magnitude near 1g AND device not spinning → trust accel
    // Contaminated: impact or rotation in progress → trust gyro
    const accelDeviation = Math.abs(rawMag - 1.0);
    const beta = (accelDeviation < 0.15 && omegaMag < STATIONARY_OMEGA)
      ? BETA_CLEAN
      : BETA_CONTAMINATED;

    // Freefall detection
    if (rawMag < FREEFALL_THRESHOLD && rawMag > 0.0001) {
      freefallCount++;
      if (freefallCount > maxFreefallRun) maxFreefallRun = freefallCount;
    } else {
      freefallCount = 0;
    }

    // Normalize accelerometer (skip if near-zero — avoids NaN)
    if (rawMag < 0.0001) continue;
    ax /= rawMag; ay /= rawMag; az /= rawMag;

    // ── Madgwick AHRS update ──────────────────────────────────────────────
    const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
    const _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2;
    const _8q1 = 8 * q1, _8q2 = 8 * q2;
    const q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;

    // Gradient descent — objective function gradient for accelerometer
    let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
    let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
    let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
    let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
    const sn = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
    if (sn > 0.0001) { s0 /= sn; s1 /= sn; s2 /= sn; s3 /= sn; }

    // Gyro integration with adaptive β correction
    const qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz) - beta * s0;
    const qDot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy) - beta * s1;
    const qDot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx) - beta * s2;
    const qDot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx) - beta * s3;
    q0 += qDot0 * DT; q1 += qDot1 * DT; q2 += qDot2 * DT; q3 += qDot3 * DT;

    // Renormalize quaternion
    const qn = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
    if (qn > 0.0001) { q0 /= qn; q1 /= qn; q2 /= qn; q3 /= qn; }

    // ── Roll / pitch from quaternion ──────────────────────────────────────
    const roll = Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2));
    const sp = 2 * (q0 * q2 - q3 * q1);
    const pitch = Math.asin(sp > 1 ? 1 : sp < -1 ? -1 : sp);

    if (i === 0) { rollStart = roll; pitchStart = pitch; }
    rollEnd = roll; pitchEnd = pitch;

    // ── Tilt-corrected translational acceleration ─────────────────────────
    // Rotate raw accel into Earth frame, subtract gravity, rotate back
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp2 = Math.sin(pitch);
    const atx = cp * s[0] + sp2 * sr * s[1] - sp2 * cr * s[2];
    const aty = cr * s[1] + sr * s[2];
    const atz = -sp2 * s[0] + cp * sr * s[1] + cp * cr * s[2] - 1.0; // subtract g
    const aTransMag = Math.sqrt(atx * atx + aty * aty + atz * atz);

    sumATransMag += aTransMag;
    sumATransMagSq += aTransMag * aTransMag;
    sumOmega += omegaMag;
    if (omegaMag > maxOmega) maxOmega = omegaMag;
    if (aTransMag > maxATransMag) {
      maxATransMag = aTransMag;
      aTransAtPeak = [atx, aty, atz];
    }
    count++;
  }

  // ── Post-pass statistics ──────────────────────────────────────────────────
  const avgATrans = count > 0 ? sumATransMag / count : 0;
  const avgOmega = count > 0 ? sumOmega / count : 0;
  const aTransVar = count > 0
    ? (sumATransMagSq / count) - (avgATrans * avgATrans)
    : 0;
  const deltaRollDeg = Math.abs(rollEnd - rollStart) * 180 / Math.PI;
  const deltaPitchDeg = Math.abs(pitchEnd - pitchStart) * 180 / Math.PI;
  const deltaAngleDeg = deltaRollDeg + deltaPitchDeg;

  // Stationary detection from first 5 samples
  const first5 = omegaHistory.slice(0, 5);
  const stationaryBefore = first5.length > 0
    && first5.every(w => w < STATIONARY_OMEGA);

  const freefallDetected = maxFreefallRun >= FREEFALL_MIN_SAMPLES;

  // ── Classification ────────────────────────────────────────────────────────

  let classification: MadgwickOutput["classification"] = "unknown";

  // 1. Freefall gate — always check first (safety-critical)
  if (freefallDetected) {
    classification = "freefall";
  }
  // 2. Crash — high translational impact, often with spin
  else if (maxATransMag > 2.5) {
    classification = "crash";
  } else if (maxATransMag > 1.5 && maxOmega > 5.0) {
    classification = "crash";  // spinning collision
  }
  // 3. Tilt — orientation changed, but no real impact
  else if (maxATransMag < 0.3 && deltaAngleDeg > 15 && maxOmega < 2.0) {
    classification = "tilt";
  }
  // 4. Vibration — sustained oscillation, no net orientation change
  else if (aTransVar > 0.5 && avgATrans < 0.3 && deltaAngleDeg < 5) {
    classification = "vibration";
  }
  // 5. Bump — moderate impact, brief, device was stationary
  else if (maxATransMag > 0.3 && maxATransMag <= 2.5 && stationaryBefore) {
    classification = "bump";
  }
  // 6. Bump — moderate impact without stationary confirmation (lower confidence
  //    but still a bump)
  else if (maxATransMag > 0.3 && maxATransMag <= 2.5) {
    classification = "bump";
  }
  // 7. Fallback
  else {
    classification = "unknown";
  }

  return {
    a_trans: {
      x: round3(aTransAtPeak[0]),
      y: round3(aTransAtPeak[1]),
      z: round3(aTransAtPeak[2]),
    },
    roll: round2(rollEnd * 180 / Math.PI),
    pitch: round2(pitchEnd * 180 / Math.PI),
    freefall: freefallDetected,
    classification,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
