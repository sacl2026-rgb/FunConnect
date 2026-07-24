# RESEARCHER.md — Madgwick AHRS, Disturbance Classification & ML Pipeline

**Role:** Science lead — sensor fusion, event classification, simulation, ML roadmap
**Date:** 2026-07-17
**Status:** `madgwick.ts` deployed — imported by Edge, called synchronously in `webSocketMessage()`, ~5ms per 75-sample alert frame. 3 enriched alerts confirmed in production (-1.9g to -2.05g). `signature-analysis.md` complete — all 64 signatures enriched with 11 literature sources. `signature-map.json` exported (v1.0.0, stable) for Agent AI keyed reference. Prompt spec (§11) and embedding corpus spec (§12) delivered. Accelerometer-only classification path (§4.6) specified — threshold-based fallback for 3-DOF hardware (micro:bit v1, bare accelerometers, no gyroscope). Simulation framework (§5) specified — implementation is next. ML pipeline (§6) designed, awaiting simulation data + ≥200 labeled alerts.

---

## 1. Madgwick AHRS — Documented Understanding

### 1.1 What It Does

The Madgwick filter fuses 3-axis gyroscope and 3-axis accelerometer data to estimate 3D orientation as a unit quaternion `q = (qw, qx, qy, qz)`. It then separates gravitational acceleration (always ~1g toward Earth's center) from translational acceleration (real impacts, motion). The filter runs at the sample rate — 25 Hz, Δt = 40ms per step.

### 1.2 The Math (from the Demo's production implementation)

**Quaternion update loop** (per sample):

```
1. NORMALIZE accelerometer: â = a_raw / ||a_raw||
2. GRADIENT DESCENT step — find rotation that aligns device Z with gravity:
     f(q, â) = objective function measuring quaternion alignment error
     ∇f = Jacobian of f — 4×1 gradient vector
     Normalize ∇f → s = ∇f / ||∇f||
3. GYRO INTEGRATION:
     q̇_ω = ½ q ⊗ [0, ωx, ωy, ωz]    (quaternion rate from angular velocity)
4. FUSE (weighted blend, β = 0.1):
     q̇ = q̇_ω − β · s               (gyro prediction, gradient correction)
     q ← q + q̇ · Δt                 (Euler integration)
5. NORMALIZE quaternion: q ← q / ||q||
```

**Gravity separation** (the key output):

```
Roll  = atan2(2(q0·q1 + q2·q3), 1 − 2(q1² + q2²))
Pitch = asin(2(q0·q2 − q3·q1))

R = rotation matrix from (roll, pitch)

a_trans_body = R · a_raw − [0, 0, −1]    ← subtract gravity in Earth frame,
                                            rotate back to body frame
|a_trans| = √(atx² + aty² + atz²)        ← true translational impact magnitude
```

**β parameter:** 0.1 is the gyro measurement error convergence rate. Higher β trusts the accelerometer more (faster convergence, noisier). Lower β trusts the gyro more (smoother, slower to correct drift). For MEMS IMUs (MPU-6050 class in CyberPi), 0.033–0.1 is the standard range. The Demo uses 0.1 — aggressive correction, appropriate for disturbance detection where orientation can change rapidly.

### 1.3 The Key Discriminator

| Scenario | Raw |a_raw| | Madgwick |a_trans| | What's happening |
|---|---|---|---|---|---|
| Hard crash | High (2g+) | High (2g+) | Real impact — gravity already accounted for |
| Spinning collision | Moderate (1.5g) | **High (2g+)** | Gravity leaked into X/Y during spin — Madgwick corrects, reveals true impact |
| Slow tilt | High (1.5g) | **Low (<0.3g)** | Gravity vector rotated — Madgwick subtracts it, reveals no real impact |
| Freefall | Near zero (~0.1g) | Near zero | All axes near zero — gravity absent |
| Vibration | Oscillating ±0.3g | Oscillating ±0.3g | High-frequency, low net displacement |

The contradiction cases (spinning collision, slow tilt) are **only detectable with sensor fusion**. Threshold-based detection alone cannot distinguish them.

### 1.4 Delivered Implementation

The production Madgwick implementation lives at:
**`C:\Projects\FunConnect\Researcher\madgwick.ts`** (217 lines)

- Input: `samples: number[][]` (75 × 6), no signature needed (classification runs inside)
- Output: `MadgwickOutput` with a_trans vector (x,y,z), roll/pitch (degrees), freefall boolean, 6-class classification
- Adaptive β: 0.96 when | |a|−1 | < 0.15g AND |ω| < 0.5 rad/s, 0.0015 otherwise. Three-line gating function.
- Gyro conversion: °/s → rad/s (CyberPiOS `get_gyro()` returns °/s)
- Proven: ~5ms in V8 for 75 samples

Edge imports it and calls it synchronously in `webSocketMessage()`. The original Demo implementation at `C:\Projects\Demo\hub\src\madgwick.ts` (162 lines, fixed β) served as the starting point but has been superseded.

### 1.5 The MATH_MODEL_REFERENCE

The compact physics reference (from Demo's `tools.ts`) documents:

- **Layer 0 — Jerk-Based Wake Gate:** EMA resting gravity vector (γ=0.004, τ≈10s), departure d(t), velocity ḋ, jerk d̈, angular rate ω. Gate: d>0.3g ∧ |ḋ|>0.5 g/s ∧ |d̈|>80 g/s² ∧ ω>15 rad/s.
- **Layer 1 — Madgwick + Seismic Conjunction:** Quaternion fusion, tilt correction via R∈SO(3), conjunction C(t) = (max ω > 0.015 rad/s) ∧ (max a_trans > 0.15 m/s²). Slow tilt and desk spin both blocked — only events carrying both translational and rotational energy pass.
- **Interpretation guide:** ω>30 + a_trans>20 = tumbling impact. ω<5 + a_trans>20 = straight collision. ω>30 + a_trans<5 = spinning in place. Freefall + high a_trans = airborne then landed.

This reference is primarily for LLM context injection (not the classification logic itself), but the physics thresholds inform our rule design.

### 1.6 Why Quaternions — Not Euler Angles, Not Rotation Matrices

The representation choice is not cosmetic. It determines whether the filter survives the events we care about.

**Euler angles (roll, pitch, yaw) — intuitive but broken:**

Gimbal lock. When pitch approaches ±90°, the roll and yaw axes collapse into each other. One degree of freedom vanishes. At 90° pitch, infinitely many (roll, yaw) pairs produce the same physical orientation, and tiny orientation changes cause Euler angles to jump discontinuously. The CyberPi can be at any orientation during a crash — dropped, tossed, tumbling. If it passes through ±90° pitch, Euler angles explode. Madgwick would produce garbage at the moment orientation matters most.

```
Pitch → 90°:
  Roll  → undefined (atan2(0, 0))
  Yaw   → undefined (atan2(0, 0))
  Filter → diverges
```

Every rotation sequence (XYZ, ZYX, XZX) has a gimbal lock singularity somewhere. You're just choosing which orientation kills you.

**Rotation matrices (3×3, 9 numbers) — correct but drifts:**

A rotation matrix can represent any orientation without singularities. But integrating angular velocity into it has no clean closed form — you need Rodrigues' rotation formula or matrix exponentials, both heavy. Worse: floating-point rounding accumulates. The matrix drifts away from orthogonality — columns stop being unit length and mutually perpendicular. It shears and scales instead of rotating. Re-orthogonalization (Gram-Schmidt) costs a square root, several divisions, and cross products per iteration.

**Quaternions (4 numbers) — the sweet spot:**

| Property | Euler | Matrix | Quaternion |
|---|---|---|---|
| Gimbal lock | Yes — always | No | No |
| Drift correction | Must recompute from accel | Gram-Schmidt (heavy) | One normalize (trivial) |
| Integrate ω → orientation | Trig functions, singular | Rodrigues formula | q̇ = ½ q ⊗ ω (linear, cheap) |
| Rotate a vector | Convert to matrix first | 9 mult + 6 add | Sandwich product (cheap) |
| Composition (q₂ after q₁) | Add angles (wrong when axes cross) | Matrix multiply (27 mult) | Quaternion multiply (16 mult) |

Quaternions are the only representation where all four operations Madgwick needs — integrate angular velocity, gradient-descent toward gravity, renormalize, and rotate vectors — are cheap, stable, and singularity-free. That's the entire reason.

The quaternion derivative from gyro data is linear:

```
q̇ = ½ q ⊗ [0, ωx, ωy, ωz]
```

No trig. No matrices. No singularities. One quaternion multiplication per iteration. Renormalization is one inverse square root. The gradient descent correction (Madgwick's innovation) works because quaternions form a smooth manifold with a well-defined gradient everywhere. Matrices don't (too many degrees of freedom — constraining 9 numbers to stay orthogonal is a constrained optimization problem, not simple gradient descent). Euler angles don't (singularities in the derivative).

### 1.7 Adaptive β — Learning the Gain

β = 0.1 is a compromise. It assumes the accelerometer's earth-frame estimate is contaminated ~10% of the time, on average. During a 2-second crash, the accelerometer is wrong for 200ms — 5 consecutive samples where Madgwick steers orientation toward the false "gravity" vector (the impact, not Earth).

**The core tension every iteration:**

```
Accel reads: a = [0.5, -0.2, -0.85]
Is this because:
  (A) Device tilted → gravity IS [0.5, -0.2, -0.85] in device frame
      → TRUST accel, correct q → use HIGH β
  (B) Device crashed → 0.5g on X is real impact, not gravity leakage
      → IGNORE accel, trust gyro → use LOW β
```

Fixed β cannot distinguish these. Adaptive β can.

**Published precedent — Jansen et al. (2021, University of Twente):**

Extended Madgwick with a decision tree classifier that decides, at each timestep, whether the accelerometer reading is trustworthy:

| Condition | β | When |
|---|---|---|
| Earth-frame estimate trustworthy | β_high = 0.96 | Stationary or slowly rotating — accel ≈ gravity |
| Earth-frame estimate contaminated | β_low = 0.0015 | During impacts, rapid motion — accel corrupted by translation |

The decision tree used raw IMU features: |a_raw| deviation from 1g, ω magnitude, rate of change of |a_raw|. No external sensors. Results on wheelchair sports test data:

| Filter | RMSE (°) | Correlation |
|---|---|---|
| Original Madgwick (fixed β) | 11.7 | 0.72 |
| ML-Extended Madgwick (adaptive β) | 7.6 | 0.87 |

**How this maps to FunConnect:**

We already have the switching signal. The 6-bit signature, omega magnitude, and raw accel departure give us the classification of "is this sample during a disturbance?" at each timestep:

```
IF | |a_raw| − 1.0 | < 0.15g AND |ω| < 0.5 rad/s:
  β = 0.1    ← quiescent: trust accel, correct gyro drift
ELSE:
  β = 0.01   ← disturbance in progress: trust gyro, ignore accel
              (impact acceleration is NOT gravity)
```

This is the binary-switching approach. The next level — future work — is learning a continuous β per sample via a small neural net:

```
features = [ |a_raw|, |ω|, |a_raw − g_prev|, |q̇|, accel_variance_in_window ]
→ tiny MLP (6 → 8 → 1) → β(t) ∈ [0.001, 0.5]
```

Train end-to-end on synthetic crash trajectories where ground-truth orientation is known. Minimize orientation error vs. ground truth. The simulation framework in §5 provides the training data.

The analytical approach is also possible — β derives from gyro noise density:

```
β ≈ √(¾) × ω_max × √(gyro_noise_density² × bandwidth)
```

For the MPU-6050-class IMU in the CyberPi, this gives β ≈ 0.033–0.1, matching empirical practice. But datasheet parameters don't capture installation effects (PCB flex, thermal drift). Learned β adapts to the actual deployment.

---

## 2. Implementation Surface — Recommendation

### 2.1 Recommended: Dual-Path (Synchronous Primary + Async Secondary)

**Path A — DO-Synchronous (primary):**

Madgwick runs as a synchronous function call inside `webSocketMessage()` in the `case "alert"` handler.

| Factor | Assessment |
|---|---|
| Latency | ~5ms (proven in Demo prototype) |
| Hibernation-safe | **Yes** — pure math, zero `await`, zero network I/O |
| Network cost | **Zero** — no additional fetch, no outbound call |
| Coupling | Tight with Edge — but Madgwick is ~160 lines of pure functions, not a subsystem |
| Quota impact | None — CPU time inside the DO, not a separate billed request |
| Dashboard broadcast | **Free** — result is available immediately for WebSocket broadcast |

This is the clear winner for normal operation. The hot-path constraint in `webSocketMessage()` is about **not awaiting**, not about CPU time. Five milliseconds of synchronous math on an alert event (rare, not every telemetry frame) is negligible. Alerts are the exception, not the steady state.

**Path C — Async Batch Processor (secondary, complementary):**

A separate Worker or cron trigger processes `alerts WHERE madgwick_json IS NULL` rows.

| Factor | Assessment |
|---|---|
| Reprocessing | Algorithm changes, β tuning — recalculate historical alerts without touching the DO |
| ML inference | Workers AI requires `await fetch()` — cannot run in DO-synchronous path |
| Backfill | New deployments can enrich existing unprocessed alerts |
| Separation | Clean architectural boundary — science code lives in its own Worker |

### 2.2 Rejected Options

**Option B — Separate Worker invoked by DO:** Requires `await fetch()` inside `webSocketMessage()`, which violates the hibernation non-negotiable (ALPHA.md §5.4: "No awaited I/O in message handlers"). The DO would stay in memory for the entire fetch round-trip (~50ms) instead of hibernating. This is the worst of both worlds — coupling without latency benefit.

### 2.3 Coordination with Edge (deployed)

Edge implemented:

1. **`alert_buffer` DO-local table** — schema (deployed):
   ```sql
   CREATE TABLE IF NOT EXISTS alert_buffer (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       device_id TEXT NOT NULL,
       event TEXT NOT NULL DEFAULT 'disturbance',
       accel_peak REAL,
       omega_peak REAL,
       signature INTEGER,
       samples_json TEXT NOT NULL,
       madgwick_json TEXT,
       created_at INTEGER,
       flushed INTEGER DEFAULT 0
   );
   ```

2. **`case "alert"` in `webSocketMessage()`** — parses the alert frame, calls `madgwick(samples)`, stores result as `madgwick_json`, broadcasts to dashboards. Synchronous, ~5ms.

3. **`alerts` D1 table** via migration `0004_alerts.sql` (deployed):
   ```sql
   CREATE TABLE IF NOT EXISTS alerts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       device_id TEXT NOT NULL,
       event TEXT NOT NULL DEFAULT 'disturbance',
       accel_peak REAL,
       omega_peak REAL,
       signature INTEGER,
       madgwick_json TEXT,
       recorded_at INTEGER,
       created_at INTEGER DEFAULT (unixepoch())
   );
   CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device_id, created_at);
   ```

4. **Alarm handler** flushes `alert_buffer` → D1 `alerts` (same pattern as telemetry flush). Deployed.

5. **No changes to Firmware.** The 50×6 ring buffer, 25 Hz, 6-bit signature — all locked. The device stays a soldier.

### 2.4 What Edge Calls

```typescript
// In device-hub.ts, webSocketMessage(), case "alert":
import { madgwick } from "./madgwick";

const start = Date.now();
const result = madgwick(msg.samples);  // single arg — classification built-in
const madgwickJson = JSON.stringify({
  ...result,
  processing_ms: Date.now() - start,
});
// INSERT to alert_buffer with madgwickJson
// Broadcast to dashboards
```

---

## 3. `madgwick_json` Output Schema (shipped)

### 3.1 Contract (as delivered in madgwick.ts)

```typescript
interface MadgwickOutput {
  a_trans: { x: number; y: number; z: number };  // translational accel at peak impact (g)
  roll: number;                                   // degrees at end of window
  pitch: number;                                  // degrees at end of window
  freefall: boolean;                              // ≥4 consecutive samples < 0.35g
  classification: "crash" | "bump" | "tilt" | "freefall" | "vibration" | "unknown";
}
```

Five fields. Edge serializes to JSON, stores in D1 `alerts.madgwick_json`. Beauty renders. Firmware smoke-tests.

### 3.2 Future Expansion (async batch processor)

The DO-synchronous path returns only these 5 fields. The async batch processor (Path C, §2.1) can enrich with per-sample timeseries, signature decode, confidence scores, and impact direction. Stored in a separate `madgwick_enriched_json` D1 column, populated asynchronously. The DO hot path stays lean.

---

## 4. Event Classification

### 4.1 Categories (6-class — shipped in madgwick.ts)

The contract Alpha specified. Edge-facing. Only what Madgwick + a simple decision tree can determine from IMU data alone.

| # | Class | Description | Threshold |
|---|---|---|---|
| 1 | **crash** | Hard collision — struck something or was struck | a_trans > 2.5g, OR (a_trans > 1.5g ∧ ω > 5 rad/s spinning collision) |
| 2 | **bump** | Moderate to light contact — tap, push, desk bump | 0.3g < a_trans ≤ 2.5g |
| 3 | **tilt** | Slow orientation change, no real impact | a_trans < 0.3g, Δangle > 15°, ω < 2 rad/s |
| 4 | **freefall** | Zero-g detected — airborne, dropped | ≥4 consecutive samples with |a_raw| < 0.35g |
| 5 | **vibration** | Sustained oscillation, no net orientation change | a_trans variance > 0.5, avg a_trans < 0.3g, Δangle < 5° |
| 6 | **unknown** | Doesn't match any rule — fallback | — |

This is a simplification of the earlier 10-class scheme. `bump` absorbs `collision` and `nudge`. `impact_landing`, `pickup`, and `spin` are deferred — they require features (freefall→impact correlation, stationary-before/after detection, pure-rotation signature decode) that belong in the async batch processor with richer feature extraction, not in the 5ms DO-synchronous path.

### 4.2 Classification Logic (as shipped in madgwick.ts)

Ordered decision tree. Freefall first — safety-critical, must never be misclassified as a lesser event. Then crash (highest energy). Then tilt/vibration (low energy, discriminated by orientation change). Then bump (catch-all for moderate impacts). Unknown fallback.

```
INPUT: max_a_trans, max_omega, a_trans_variance, delta_angle, stationary_before, freefall_detected

1. FREEFALL CHECK (always first)
   IF freefall_detected → "freefall"

2. CRASH CHECK
   IF max_a_trans > 2.5g → "crash"
   IF max_a_trans > 1.5g AND max_omega > 5.0 rad/s → "crash" (spinning collision)

3. TILT CHECK
   IF max_a_trans < 0.3g AND delta_angle > 15° AND max_omega < 2.0 rad/s → "tilt"

4. VIBRATION CHECK
   IF a_trans_variance > 0.5 AND avg_a_trans < 0.3g AND delta_angle < 5° → "vibration"

5. BUMP CHECK
   IF max_a_trans > 0.3g AND max_a_trans ≤ 2.5g AND stationary_before → "bump"
   IF max_a_trans > 0.3g AND max_a_trans ≤ 2.5g → "bump"  (lower confidence, but still a bump)

6. FALLBACK
   → "unknown"
```

### 4.3 Confidence — Deferred to Async Processor

The shipped `madgwick()` returns a classification string without a confidence score. The DO-synchronous path is 5 fields, no more. Confidence scoring and `class_reason` strings belong in the async batch processor (Path C), which has access to richer features and can run heavier logic.

### 4.4 ML Swap-In Point

The classification logic is inside `madgwick.ts` as an ordered decision tree. When an ML model replaces it, the function signature stays the same — Edge's import doesn't change:

```typescript
// Today: rule-based decision tree inside madgwick()
// Future: same function, ML model replacing the decision tree
export function madgwick(samples: number[][]): MadgwickOutput;
```

The ML model takes the same 75×6 samples and internal Madgwick features (max_a_trans, delta_angle, a_trans_variance, etc.) and returns the same `MadgwickOutput` shape. Edge is insulated from the change.

### 4.5 Why Rule-Based First

1. **No training data exists yet.** We need classified events to train on.
2. **Deterministic and explainable.** Every classification follows an auditable decision path.
3. **Deployable now.** The 10,000-simulation signature dictionary (§5) calibrates thresholds before real alerts arrive.
4. **ML ceiling is higher, but the floor is lower.** A trained classifier on few labeled events will have high variance. A rule-based system on known physics is consistently reasonable from day one.

### 4.6 Accelerometer-Only Classification Path (3-DOF)

When only a 3-axis accelerometer is available — no gyroscope — the Madgwick filter cannot run. This section defines the fallback classification pipeline for 3-DOF hardware such as the micro:bit v1, bare ADXL345-class accelerometers, or any sensor package lacking angular rate data.

#### 4.6.1 Why Madgwick Cannot Run Without a Gyroscope

Madgwick's core loop requires two things every iteration:

1. **Gyro integration** — `q̇ = ½ q ⊗ ω` predicts the next orientation from angular velocity. Without ω, there is no prediction step.
2. **Gradient descent correction** — the accelerometer's gravity-direction estimate corrects gyro drift. Without ω, there is nothing to correct.

The quaternion update collapses. You cannot track orientation through time from acceleration alone — the gravity vector gives instantaneous tilt (pitch and roll) when stationary, but the moment the device accelerates, `a_raw = gravity + translation` and the two are permanently mixed. The key Madgwick discriminator — "is this 1.5g reading from a real impact or from gravity leaking into X/Y during a tilt?" — is unanswerable.

| Property | 6-DOF (accel + gyro) | 3-DOF (accel only) |
|---|---|---|
| Freefall detection (`\|a_raw\| ≈ 0`) | ✓ | ✓ |
| Hard crash detection (`\|a_raw\| > 2.5g`) | ✓ | ✓ |
| Moderate bump detection | ✓ with confidence | ✓ with degraded confidence |
| Tilt vs. bump discrimination | ✓ (Madgwick gravity separation) | Partial (heuristics) |
| Spinning collision detection | ✓ (ω + a_trans conjunction) | ✗ |
| Orientation tracking over time | ✓ (quaternion integration) | Static tilt only (when still) |
| Yaw (rotation around gravity) | ✓ | ✗ |
| `\|a_trans\|` (true impact magnitude) | ✓ | ✗ |
| Classification granularity | 6-class | ~4-class |

#### 4.6.2 What Survives

**Freefall detection — unchanged.** `|a_raw| ≈ 0` is orientation-independent. Zero is zero.

**Jerk-based wake gate — mostly intact.** The Layer 0 gate (MATH_MODEL_REFERENCE) uses `|a_raw|` departure from a resting EMA, its first derivative, and second derivative (jerk). The `ω > 15 rad/s` clause is lost, but the accel-side triggers still fire:

```
d(t) = | |a_raw| − g_ema |    → departure from resting gravity
d > 0.3g ∧ |ḋ| > 0.5 g/s ∧ |d̈| > 80 g/s²
```

This catches sharp impacts. What it misses: pure spins where `|a_raw|` stays near 1g but the device is rotating fast (no translational signature to trigger on).

**Tilt estimation when stationary — works.** When `|a_raw| ≈ 1g` (no translational acceleration), the gravity vector direction gives pitch and roll directly:

```
pitch = atan2(ax, sqrt(ay² + az²))
roll  = atan2(ay, az)
```

No quaternion integration needed. This is trigonometry on the gravity vector. The catch: the moment the device accelerates, the reading becomes `gravity + translation` and they cannot be separated.

**Vibration detection — works.** High-frequency, low-amplitude oscillation in `|a_raw|` is vibration regardless of orientation. The variance-based check adapts directly — use raw magnitude variance instead of a_trans variance.

**Hard crash detection — works.** `|a_raw| > 2.5g` is unambiguously a crash. Even if all 1g of gravity is on the wrong axis, the remaining 1.5g is still a real impact.

#### 4.6.3 What Is Lost — The Ambiguous Middle

The damage is in the 1.0g–2.5g band:

| Scenario | Raw `\|a_raw\|` | True `\|a_trans\|` | 6-DOF verdict | 3-DOF verdict | Error |
|---|---|---|---|---|---|
| Hard crash | 2.5g+ | 2.5g+ | crash | crash | None |
| Spinning collision | 1.5g | 2.0g+ | crash | **bump** | False negative — real crash undersold |
| Slow tilt | 1.5g | <0.3g | tilt | **bump** (or false crash) | False positive — tilt calls itself a bump |
| Moderate bump | 1.5g | 1.5g | bump | bump | None |
| Freefall | ~0.1g | ~0.1g | freefall | freefall | None |
| Vibration | oscillating ±0.3g | oscillating ±0.3g | vibration | vibration | None |

The spinning collision and slow tilt both produce `|a_raw| ≈ 1.5g` but are opposites in reality. Without gyro data, they land in the same classification bin.

#### 4.6.4 Accelerometer-Only Classification Pipeline (3 Tiers)

**Tier 1 — Threshold-based baseline (minimum viable):**

```
Input: 75 × 3 samples [ax, ay, az]  (no gyro columns)

1. Compute |a_raw| per sample
2. FREEFALL: any run of ≥4 consecutive samples where |a_raw| < 0.35g
   → "freefall"
3. CRASH: max(|a_raw|) > 2.5g
   → "crash" (high confidence — even with worst-case gravity alignment,
      at least 1.5g of real impact remains)
4. BUMP: max(|a_raw|) between 1.5g and 2.5g
   → "bump" (low confidence — could be tilt, could be real impact;
      ambiguity is inherent without gyro)
5. VIBRATION: variance of |a_raw| > 0.5 AND max(|a_raw|) < 1.5g
   → "vibration"
6. Everything else → "unknown"
```

This is 4-class output: freefall, crash, bump, vibration. No tilt class (can't distinguish from bump). No unknown in practice for any event that triggers the jerk gate.

**Tier 2 — Tilt heuristic (improve specificity):**

If the device is assumed to start approximately level (reasonable for a classroom robot on a desk), compare the first few samples' gravity vector direction to the peak-event direction:

```
g_start = avg of first 5 samples (should be ~[0, 0, 1] if level)
g_event = accel vector at peak |a_raw|

angle = acos(g_start · g_event / (|g_start| × |g_event|))

IF angle > 30° AND max(|a_raw|) < 2.0g:
  → likely a tilt, not a bump → "tilt"
```

This recovers some tilt-vs-bump discrimination. Limitations: fails if the device started tilted, or if a real impact happens to align with the starting orientation.

**Tier 3 — Temporal proximity check (rise-time discrimination):**

Real impacts are sharp (spike in 1–2 samples, fast decay). Tilts are gradual (sustained over many samples). Compute the rise time of the magnitude envelope:

```
Find: first sample where |a_raw| crosses 1.2g (event start)
Find: sample where |a_raw| reaches its maximum (peak)

rise_samples = peak_index − start_index

rise_samples ≤ 2 → impact-like (sharp onset)
rise_samples ≥ 5 → tilt-like (gradual)
```

This is the accelerometer-only analog of the jerk gate's temporal discrimination. No gyroscope needed — it examines the shape of the magnitude envelope, not the orientation path. Combine with Tier 2 for best results:

```
IF angle > 30° AND rise_samples ≥ 5 AND max(|a_raw|) < 2.0g:
  → "tilt" (high confidence — both heuristics agree)
IF angle > 30° OR rise_samples ≥ 5:
  → "tilt" (lower confidence — one heuristic fires)
ELSE:
  → "bump"
```

#### 4.6.5 Function Signature

The accelerometer-only classifier is a separate function from `madgwick()`. It takes a different input shape (3 columns, not 6) and returns a different output shape (no a_trans, no roll/pitch from quaternion — only static tilt estimates):

```typescript
export interface AccelOnlyOutput {
  max_raw_mag: number;                               // peak |a_raw| during window (g)
  tilt_angle_deg: number;                            // angle between start and peak gravity vectors
  rise_samples: number;                              // samples from threshold-cross to peak
  freefall: boolean;                                 // ≥4 consecutive samples < 0.35g
  classification: "crash" | "bump" | "tilt" | "freefall" | "vibration" | "unknown";
  confidence: "high" | "low";                        // always "low" for bump (ambiguity inherent)
}

export function classifyAccelOnly(samples: number[][]): AccelOnlyOutput;
```

#### 4.6.6 Contract With Edge

The `CyberpiHub` DO already routes by device type. When a micro:bit or other 3-DOF device connects and sends `alert` frames, Edge calls `classifyAccelOnly()` instead of `madgwick()`. The D1 `alerts` table stores the result in a separate `accel_only_json` TEXT column (or reuses `madgwick_json` with a `classifier: "accel_only"` discriminator in the JSON).

**Firmware impact:** The 3-DOF device still ships 75-sample ring buffers, but with 3 columns instead of 6. The `alert` frame format is otherwise identical — same `type`, `device_id`, `event`, `signature` fields. The 6-bit signature loses gyro bits (bits 3–5 are always 0 on 3-DOF hardware), leaving only 8 possible signatures (0–7) from the accelerometer axes.

#### 4.6.7 When To Use

| Hardware | IMU | Classifier | Rationale |
|---|---|---|---|
| CyberPi | 6-DOF (MPU-6050 class) | `madgwick()` | Full Madgwick with adaptive β |
| micro:bit v1 | 3-DOF (accelerometer only) | `classifyAccelOnly()` | No gyroscope available |
| micro:bit v2 | 3-DOF + compass | `classifyAccelOnly()` | Compass gives heading, not angular velocity — still no Madgwick |
| Generic ADXL345 | 3-DOF | `classifyAccelOnly()` | Bare accelerometer |
| Musebricks | TBD | TBD | Depends on which IMU ships |

#### 4.6.8 Design Principle

The accelerometer-only path is not "Madgwick without gyro." It is a **different classifier** with a different feature space, different performance expectations, and a different output contract. The 6-DOF path remains the gold standard. The 3-DOF path is a threshold-based fallback that explicitly signals its lower confidence to downstream consumers (Beauty dashboard, Agent AI chatbot). The `confidence` field is the honesty mechanism — it tells the chatbot to say "something triggered the sensors, but without a gyroscope I can't tell if it was a bump or a tilt" instead of pretending certainty.

The Tier 2 and Tier 3 heuristics recover some discrimination, but they are heuristics — they make assumptions (device starts level, impacts are sharper than tilts) that will fail in edge cases. The confidence field degrades to "low" whenever these heuristics disagree or when the measurement lands in the ambiguous band.

---

## 5. Simulation — Newtonian Rigid Body at Scale

### 5.1 The Idea

Don't hand-craft 10 scenarios. Build a rigid-body physics simulator, randomize initial conditions, run tens of thousands of crashes, and see what 6-bit signatures and Madgwick outputs emerge. This produces a **signature dictionary** — for each of the 64 possible signatures, a calibrated distribution of physical scenarios, expected a_trans ranges, and classification probabilities.

The approach is established in the literature:
- **Tang et al. (2024)** — generated synthetic IMU data from biomechanical simulations, trained an LSTM on synthetic data, achieved 92% accuracy on real fall detection datasets. Structurally identical to our crash classification problem.
- **Oishi et al. (2025)** — physics-simulated data augmentation for IMU-based activity recognition. Achieved competitive performance with 60% fewer real training subjects.
- **oxiphysics-rigid** (Rust crate, Apache-2.0) — open-source rigid body simulator with built-in `ImuSensor` model: gyro/accel noise density, bias drift, scale factor errors. Drop-in ready.
- **MATLAB Sensor Fusion Toolbox** — `imuSensor` object with configurable noise parameters. Used in published papers for synthetic IMU generation.

### 5.2 Physics Model

A rigid body with 6 degrees of freedom and an IMU mounted at offset r from the center of mass:

```
State vector (13 dimensions):
  position:     [x, y, z]            m
  orientation:  [qw, qx, qy, qz]     quaternion
  velocity:     [vx, vy, vz]         m/s
  angular_vel:  [ωx, ωy, ωz]         rad/s

IMU offset from COM:  r = [dx, dy, dz]

Gravity:          g = [0, 0, -9.81]     m/s²
Collision plane:  z = 0                 (table surface, infinite)
Wall (optional):  x = ±x_wall           (vertical barrier)
```

**The critical equation — IMU is not at the center of mass:**

```
a_IMU = a_COM + α × r + ω × (ω × r) + g
         ↑        ↑            ↑           ↑
      linear    tangential  centripetal  gravity
      accel     (Euler)     (always
                           toward axis)
```

Where `α` = angular acceleration = dω/dt. The centripetal term `ω × (ω × r)` is why the IMU registers acceleration even when the body is spinning in place with no linear motion. The gyroscope reads `ω` directly (same everywhere on a rigid body).

**Collision response (impulse-based):**

When `z < 0` (chassis penetrated table), apply an instantaneous impulse at the contact point:

```
v_z ← −e × v_z            (restitution: 0 < e < 1)
v_x, v_y ← friction_impulse (Coulomb friction cone)
ω ← ω + I⁻¹ × (r_contact × J)   (angular impulse from off-center hit)
```

### 5.3 Simulation Loop

```python
for each of 10,000 simulations:
    # Latin hypercube sampling of initial conditions
    z_0       ~ U(0.05, 1.0)        # drop height (m)
    |v_0|     ~ U(0, 5)             # initial speed (m/s)
    θ_v, φ_v  ~ hemisphere           # impact direction
    |ω_0|     ~ U(0, 10)            # initial spin rate (rad/s)
    ω_axis    ~ random unit vector   # spin axis
    q_0       ~ random orientation   # or specific poses
    e         ~ U(0.1, 0.8)         # coefficient of restitution
    μ         ~ U(0.1, 0.7)         # friction

    # Integrate at 25 Hz for 2 seconds (50 samples)
    for t in 0..49:
        a_COM = [0, 0, -9.81]       # gravity only
        v += a_COM × dt
        pos += v × dt

        # Quaternion integration
        q̇ = 0.5 × q ⊗ [0, ωx, ωy, ωz]
        q += q̇ × dt
        q = q / |q|

        # Collision detection: penetrated table?
        if pos.z < 0:
            pos.z = 0
            v.z *= -e
            # Friction impulse → modifies v.x, v.y, ω
            # Angular momentum change from contact force

        # IMU reading at sensor location (NOT at COM)
        α = (ω − ω_prev) / dt        # angular acceleration
        a_IMU = a_COM + cross(α, r) + cross(ω, cross(ω, r))

        # Add sensor noise (MPU-6050 class)
        a_IMU += gaussian(0, 0.005)    # accel noise ~0.5 mg/√Hz at 25 Hz
        gyro  = ω + gaussian(0, 0.0004) # gyro noise ~0.005 dps/√Hz at 25 Hz

        samples.append([a_IMU/g, gyro])  # convert to g and °/s

    # Feed through virtual jerk gate
    if jerk_gate_fires(samples):
        signature = compute_6bit_signature(samples)
        madgwick_result = madgwick(samples)  # single arg — classification built-in

        store: (initial_conditions, signature, madgwick_result,
                ground_truth_scenario_type)
```

### 5.4 Parameter Space and Scale

| Parameter | Range | Samples |
|---|---|---|
| Initial height z₀ | 0.05 – 1.0 m | continuous |
| Initial speed |v₀| | 0 – 5 m/s | continuous |
| Velocity direction (θ, φ) | downward hemisphere | continuous |
| Initial ω magnitude | 0 – 10 rad/s | continuous |
| ω axis | random unit vector | continuous |
| Restitution e | 0.1 – 0.8 | continuous |
| Friction μ | 0.1 – 0.7 | continuous |
| Initial orientation q₀ | 4 quaternion components | continuous |

Full factorial grid would be ~16 million combinations. Latin hypercube sampling with **10,000 runs** covers the space well — the curse of dimensionality doesn't bite because most parameter interactions are smooth. Each simulation: ~50 integration steps × 12-DOF ODE = negligible. Total compute: ~50 seconds including Madgwick processing per simulation.

**Feasibility check:** one simulation = 50 timesteps × ~5,000 FLOP (ODE + collision + IMU model) = 250,000 FLOP. Python overhead ~50 µs/simulation. 10,000 simulations = 0.5 seconds for physics + 50 seconds for Madgwick (5ms × 10,000). Trivially feasible on any laptop.

### 5.5 What You Learn — The Signature Dictionary

The simulation produces a calibrated prior for every 6-bit signature:

```
Signature 44 (101100: X accel + Z gyro):
  ┌─────────────────────────────────────────────────────┐
  │ Occurred in 847/10,000 simulations (8.5%)            │
  │                                                      │
  │ Physical scenarios that produce this signature:       │
  │   Side impact on X face, spinning around Z .... 67%  │
  │   Diagonal corner hit, slip-catch on edge .... 18%   │
  │   Vertical drop with Z-spin, lands on X edge .. 15%  │
  │                                                      │
  │ Resulting a_trans from Madgwick:                     │
  │   Mean: 1.8g    Range: 0.4g – 4.2g                  │
  │   False positive risk (a_trans < 0.3g): 3%           │
  │     → these are tilts that triggered the gate        │
  │                                                      │
  │ Classification distribution:                         │
  │   crash: 62%   collision: 28%   nudge: 7%           │
  │   vibration: 3%                                      │
  │                                                      │
  │ Best feature for discrimination:                     │
  │   a_trans × ω_z product > 3.0 → always crash        │
  │   a_trans × ω_z product < 0.5 → usually nudge       │
  └─────────────────────────────────────────────────────┘
```

This is deployed with the rule-based classifier as calibrated priors. Instead of fixed thresholds, thresholds are signature-specific and backed by simulation statistics. When the classifier sees signature 44 with a_trans = 2.1g, it doesn't just apply a generic threshold — it knows this specific signature with this a_trans value resolves to "crash" in 62% of simulated scenarios, and the a_trans × ω_z product pushes confidence higher.

### 5.6 The Bootstrapping Strategy

```
Phase A: 10,000 simulations → signature dictionary
         → calibrated rule-based classifier with per-signature thresholds
         → deploy immediately (no training data needed)
         → confidence values derived from simulation statistics

Phase B: Real alerts arrive → classifier labels them
         → high-confidence labels (>0.85) become auto-labeled training data
         → human verifies low-confidence cases → labeled ground truth
         → ML model trains on hybrid real + synthetic dataset

Phase C: ML model replaces rule-based decision tree inside `madgwick()` (same function signature — `madgwick(samples: number[][]): MadgwickOutput`)
         → continuous learning: new human-verified alerts retrain the model
         → adaptive β from §1.7 runs in the ML model
         → simulation dataset provides negative examples (what a crash DOESN'T
           look like) and edge cases that real-world data won't cover for months
```

The simulation doesn't just validate the classifier — it bootstraps the entire ML pipeline. Without simulation, we'd need months of real crash data before training anything. With simulation, we deploy with calibrated confidence on day one.

### 5.7 Success Criteria

- ≥90% accuracy on "obvious" cases (crash, freefall, tilt, spin)
- ≥75% accuracy on ambiguous cases (nudge vs. vibration, collision vs. crash boundary)
- Zero cases where freefall+impact is classified as "nudge" (dangerous false negative)
- Zero cases where slow tilt is classified as "crash" (annoying false positive)
- Per-signature classification probabilities within ±10% of simulation predictions after 100 real alerts
- Simulation correctly predicted which signatures are high-ambiguity (validation that the physics model maps to reality)

---

## 6. ML Roadmap (Future)

### 6.1 When to Switch

Trigger conditions for moving from rule-based to ML:

1. **≥200 labeled alerts** in D1 with verified classifications (human review or high-confidence auto-label)
2. **Rule-based accuracy plateaus** below 85% on real-world data
3. **A specific class is problematic** — e.g., nudge vs. vibration consistently confused

### 6.2 Feature Vector

The classifier's input is a fixed-size vector derived from Madgwick outputs:

```
[ max_a_trans, avg_a_trans, min_a_trans, a_trans_variance,
  max_omega, avg_omega, omega_variance,
  delta_roll, delta_pitch, tilt_deg,
  freefall_samples, stationary_before, stationary_after,
  signature_bits[0..5],          // one-hot encoded 6-bit signature
  accel_peak_raw, omega_peak_raw, // device-computed peaks
  sample_count ]
```

Total: 22 features. Small enough for logistic regression or a tiny neural net. The 50×6 raw ring buffer (300 floats) is available as an alternative feature space for deep learning, but the Madgwick-processed features are more interpretable and require less data to train.

### 6.3 Model Candidates (in order of complexity)

1. **Logistic regression** — 22 features → 10 classes. Fast, interpretable, low data requirement. Baseline.
2. **Random forest** — Handles nonlinear feature interactions (e.g., high a_trans + high omega = crash, not just either alone). Still interpretable via feature importance.
3. **Small feedforward NN** — 22 → 32 → 16 → 10. Captures complex interactions. Deployable via Workers AI (`@cf/meta/llama-3.2-3b-instruct` for inference, or a custom ONNX model via Workers AI).

### 6.4 Deployment

ML inference runs in the **async batch processor** (Path C), not the DO-synchronous path. Workers AI requires `await fetch()`, which violates the hibernation constraint. The DO writes `madgwick_json` with rule-based classification immediately; the async processor can overwrite with ML classification later if confidence improves.

### 6.5 Training Data Collection

Every classified alert stores:
- The full `madgwick_json` (features + rule-based classification)
- A `human_verified` boolean column in D1 (default false)
- A `verified_class` column (nullable — only populated after human review)

This builds the labeled dataset passively. No separate data collection pipeline needed.

---

## 7. Commanded Motion vs. External Disturbance — The Discrimination Problem

### 7.1 The Physics Observation

When the mBot2 executes a commanded spin (differential motor power, e.g., left wheel forward, right wheel backward for 0.1s), the IMU response depends entirely on whether the wheels grip the ground:

**Midair (wheels unloaded):**
```
Motor torque → wheels accelerate → wheels have low moment of inertia
(~0.0001 kg·m²) → reach max RPM fast → command ends at 0.1s →
bearing friction stops wheels quickly → chassis barely moves

IMU: brief ω_Z pulse, ~0.1s, low peak
```

**On ground (wheels gripping):**
```
Motor torque → wheels grip → reaction torque rotates CHASSIS →
chassis has HIGH moment of inertia (~0.005 kg·m², 50× the wheels) →
command ends at 0.1s → but chassis is already spinning with
significant angular momentum → floor friction decelerates slowly

IMU: sharp ω_Z rise during 0.1s pulse, then slow exponential decay
ω(t) = ω_peak × e^(-t/τ), τ = 0.5–3s depending on surface
```

The difference is what the motor is accelerating — just the wheels, or the entire chassis through ground reaction force. On a grippy surface like a desk or tile, grip is surprisingly high. A 0.1s full-power differential spin can create enough chassis angular momentum to keep rotating for 2–3 seconds.

### 7.2 Why It Matters

A commanded spin that outlasts the command looks **identical** to an external disturbance in the IMU data:

```
Commanded spin:   ω_Z rises fast → peaks → decays exponentially → zero
External twist:   ω_Z rises fast → peaks → decays exponentially → zero
```

At 25 Hz sample rate, the onset profiles differ by maybe one sample (~20ms motor ramp vs. smoother hand contact). The IMU alone cannot distinguish "the robot spun itself" from "something spun the robot."

For the bare CyberPi in FunConnect (no motors), this is a non-issue — every spin IS an external disturbance. But when the mBot2 base is attached and motor commands are in play, the classifier needs a second channel.

### 7.3 Mitigation: Active Braking

A forward-then-reverse motor pulse (0.1s forward, 0.1s reverse) cancels angular momentum:

```
Forward pulse:  +τ × 0.1s = I × ω_peak     → chassis spins
Reverse pulse:  −τ × 0.1s = I × (0 − ω_peak) → chassis stops
```

The angular momentum deposited by the forward pulse is removed by the reverse pulse. Total stop time: 0.2 seconds instead of 2–3 seconds of friction-only coasting.

**The catch:** open-loop. Without encoder or gyro feedback in the motor loop, the reverse pulse is blind. Surface-dependent:

| Surface | Grip | ω_peak | Reverse pulse effect |
|---|---|---|---|
| Carpet | High | High | Undershoots — chassis still spinning forward |
| Desk | Medium | Medium | Near-perfect cancellation |
| Tile / slick | Low | Low | Overshoots — chassis spins backward |

The surface dependence doesn't disappear — it shifts from "how long does it coast?" to "what's the final velocity after braking?"

### 7.4 A Detectable Signature — Jerk Symmetry

The bidirectional torque pulse produces an IMU signature that physics cannot produce accidentally:

```
Commanded spin+brake:
  ω_Z:  _/
        / \
       /   \___
      /
  ___/          ______
  → symmetric rise and fall, total duration ~0.3s

Crash / external twist:
  ω_Z:  _/
        /
       /
      /`·-..___
  ___/
  → asymmetric, long exponential tail, total duration 1–3s
```

The symmetry is the key. A forward-backward motor pulse creates roughly equal-magnitude positive and negative jerk. No collision or bump applies force in one direction and then immediately applies equal force in the opposite direction — rebound after impact always has lower energy (coefficient of restitution < 1):

```
FEATURE: jerk_symmetry = |max_positive_jerk + max_negative_jerk| / max(|jerk|)

jerk_symmetry < 0.1  → pulses nearly cancel → commanded braking
jerk_symmetry > 0.5  → asymmetric → physical collision or external force
```

This means commanded motion IS detectable from IMU alone, even without motor state telemetry — if the firmware uses active braking. The symmetric jerk profile is a fingerprint of deliberate motor reversal.

### 7.5 Recommendation

For the bare CyberPi (current FunConnect): no action needed. No motors = no self-motion = every disturbance is external.

For future mBot2 base attachment:
1. Firmware uses forward-reverse braking instead of coast/`motor_stop()`
2. Classifier adds a `commanded_motion` class — detected via jerk symmetry < 0.1
3. DO receives motor command timestamps — cross-reference with alert timestamps for suppression (<1s after command → likely self-motion, don't alert)
4. The `madgwick_json` adds a `motor_command_active` boolean field for downstream consumers

---

## 8. Edge Coordination — What They Need From Me

### 8.1 Delivered

`madgwick.ts` shipped at `C:\Projects\FunConnect\Researcher\madgwick.ts`. Edge copies it into `Edge/src/madgwick.ts` and imports `{ madgwick }`. The function is pure — zero awaits, zero bindings, ~5ms in V8.

Edge integration complete:
1. ✅ `case "alert"` handler in `webSocketMessage()` — calls `madgwick(msg.samples)` synchronously, ~5ms
2. ✅ `alert_buffer` DO-local table + alarm handler + D1 migration `0004_alerts.sql` — 3 enriched alerts confirmed in production
3. ✅ Schemas in §2.3 — deployed as specified

### 8.2 After Madgwick is deployed (current phase)

1. **Simulation results** — accuracy numbers per class, confusion matrix, edge case failures
2. **Classification tuning** — any threshold adjustments based on real alert data
3. **β parameter tuning** — if real-world performance differs from β=0.1

### 8.3 Firmware Coordination

**No changes requested.** The 75×6 ring buffer, 25 Hz sample rate, 6-bit signature encoding, and `alert` frame format are all locked. The device stays a soldier — jerk gate fires, buffer ships, no classification.

---

## 9. Files

```
C:\Projects\FunConnect\Researcher\
├── RESEARCHER.md              ← this file
├── madgwick.ts                ← DELIVERED — pure function, adaptive β, 6-class (217 lines)
├── signature-analysis.md      ← DELIVERED — 64-signature reference, enriched with 11 literature sources
├── signature-map.json         ← DELIVERED — machine-readable export (v1.0.0, stable)
│
C:\Projects\FunConnect\Edge\   ← deployment target
├── src/madgwick.ts            ← copy from Researcher/madgwick.ts
├── src/device-hub.ts          ← add case "alert" handler
├── migrations/0004_alerts.sql ← D1 alerts table
│
C:\Projects\Demo\hub\src\      ← reference (read-only, predates our implementation)
├── madgwick.ts                ← original Demo Madgwick (fixed β, pre-dates adaptive)
├── tools.ts                   ← MATH_MODEL_REFERENCE + LLM classification prompts
```

---

## 10. Open Questions

1. ~~**β fixed or adaptive?**~~ **RESOLVED.** Shipped adaptive from day one. β = 0.96 when |a| ≈ 1g and |ω| < 0.5 rad/s, 0.0015 otherwise. Three-line gate, backed by Jansen et al. (2021).

2. **Should `madgwick_json` include per-sample a_trans timeseries?** The full 75-sample Madgwick output (75 × 10 values) would be ~8KB of JSON. Recommendation stands: omit from the DO-synchronous path. Store as `madgwick_timeseries_json` in a separate column, populated by the async batch processor. Low priority — only needed for forensic investigation of specific alerts.

3. **Telegram / notification surface — who owns it?** Researcher provides classification logic. The notification pipeline (Telegram push, dashboard broadcast) is owned by Edge or Beauty. Not a science concern.

4. **Alert deduplication window.** The firmware jerk gate fires per-axis. Rapid re-triggers within the same physical event may produce duplicate alerts. Recommendation: firmware 2s cooldown. DO sets `possible_duplicate: true` if prior alert from same device within 3s. The classifier can down-weight duplicates.

5. **Simulation fidelity.** A flat-plane rigid-body collision model is a prior, not a replacement for real data. The table isn't perfectly flat, the CyberPi isn't a perfect rigid body, and the IMU has non-Gaussian noise. Track simulation-vs-reality drift over the first 100 real alerts. Calibrate thresholds from simulation; refine from real data.

6. **mBot2 base re-entry.** §7 (commanded motion discrimination) is theoretical until the mBot2 base is reattached. At that point: motor command log cross-reference + jerk symmetry heuristic.

7. ~~**Simulation or Madgwick first?~~** **RESOLVED.** Madgwick shipped. Simulation is next in queue.

8. **Classification granularity — 6 classes sufficient?** The 64-signature analysis reveals that pure Z-spin (signature 1) and multi-axis wobble (signatures 5–6) fall to "unknown" or "tilt" in the 6-class scheme. A 7th class "spin" would capture pure rotation events. Defer until real alert volume reveals how many of these occur. If <1% of alerts are pure spin, "unknown" is adequate.

9. **Per-signature chatbot voice.** The 7-class triage table has tone guidance. Individual signatures lack conversational voice lines. Agent AI can synthesize these from the rich scenario descriptions in `signature-analysis.md` using Qwen. Not a blocker for Researcher — generation-side work.

10. **Literature enrichment completeness.** All 64 signatures in `signature-analysis.md` are backed by at least one published source. The sources span 11 references. Are there additional domain-specific papers (e.g., small educational robot drop testing) that would further strengthen the corpus? Open-ended — the current set is sufficient for deployment but not exhaustive.

---

---

## 11. Prompt Engineering & LLM Context Specification

**For:** Agent AI (RAG pipeline owner)
**From:** Agent Researcher (Madgwick science lead)
**Status:** Specification — do not implement yet. Researcher owns the prompt and context format; AI implements the RAG pipeline.

---

### 11.1 System Prompt

~200 words. Persona: friendly, scientifically accurate, not alarmist. Audience: students and educators using the mBot2/CyberPi.

```
You are a friendly, observant co-pilot for a small educational robot
called the CyberPi. You talk like a calm lab partner, not a dashboard
or a status screen.

Your job: tell the user what their device just experienced, in plain
language. You receive classified disturbance data from the device's
motion sensors — crashes, bumps, tilts, freefalls, vibrations.

RULES:
- Never panic. A "crash" at robot scale is not a car accident.
- Translate numbers into human terms. "2.1g impact" becomes
  "a solid bump — like it fell off a book onto the desk."
- Freefall is safety-relevant. Always suggest checking the device's
  position after a freefall event.
- Freefall without impact: "The device briefly felt weightless but
  didn't record a hard landing. It may have been tossed and caught,
  or dropped onto something soft."
- If the device is offline: "The CyberPi appears to be offline right
  now. Last seen [N] minutes ago."
- If there are no recent alerts: "Everything's been quiet — no
  disturbances detected in the last [time period]."
- If the user asks about history or patterns: redirect. "Would you
  like me to check the alert history for this device?"
- Be specific. "Rolled 12° to the right" is better than "tilted."
- Keep it to 2–3 short sentences per response. Students scan, they
  don't read.
- If you're unsure what happened (classification = unknown): be
  honest. "Something triggered the motion sensors, but it was too
  small or brief to identify clearly."
```

**Classification-specific tone guide** (injected as a compact table, not prose):

| Class | Tone | Example opening |
|---|---|---|
| crash | Concerned, direct | "Your CyberPi took a hard hit — " |
| bump | Casual, informative | "Just a light bump detected — " |
| tilt | Neutral, observational | "The device was tilted — " |
| freefall | Safety-first, calm | "The device briefly went weightless — " |
| vibration | Curious, contextual | "Sustained vibration detected — " |
| unknown | Honest, unalarmed | "Something small triggered the sensors — " |

### 11.2 Context Format

**Recommendation: Markdown table for structured data + bullet list for narrative context.**

LLMs parse markdown tables correctly and token-efficiently. JSON is precise but costs more tokens for the same information and LLMs occasionally hallucinate field names in nested structures. Bullet lists are best for qualitative context the LLM should narrate.

**Format spec — what Agent AI passes to the LLM:**

```markdown
## Device
mbot2-01 | ONLINE | Uptime: 3h 42m

## Latest Alert (2 min ago)
| Field | Value |
|---|---|
| Classification | **crash** |
| Impact | 2.1g (mostly from the side) |
| Orientation | roll 12° right, pitch -5° forward |
| Freefall | no |

## Recent Context
- First alert in 6 hours — device was stable before this
- Device was stationary when the impact occurred
```

**Rules for the context block:**
- Always show device online/offline first — it frames everything.
- If no recent alerts: omit the alert table. Show "No disturbances in the last [N]."
- If multiple recent alerts: show the latest in the table, add a line under Recent Context: "3 alerts in the last 10 minutes — see history for details."
- If freefall + no impact: add under Recent Context: "No impact followed the freefall. Likely caught or soft landing."
- Classification is always bolded — it's the most important word on the card.
- Impact direction uses plain language: "mostly from the side" (|a_trans.x| dominates), "straight down" (|a_trans.z| dominates), "from below" (positive z), "multi-directional" (no dominant axis).

### 11.3 Richer Madgwick Context — What's Worth Adding

The current 5-field output (`a_trans`, `roll`, `pitch`, `freefall`, `classification`) is the starting point. Below is what additional context would meaningfully improve chatbot answers, ranked by impact.

**HIGH IMPACT — add these first:**

| # | Field | Why it improves answers | Where it comes from |
|---|---|---|---|
| 1 | **Impact direction label** | "Hit from the side" vs. "straight down" — turns vector into language. LLMs narrate better with direction than with (x,y,z) numbers. | Derived from a_trans vector — max component wins. Edge or batch processor. |
| 2 | **Baseline multiplier** | "2.1g = about 3× the force of a firm tap." Gives intuitive scale. Students don't know what 2.1g feels like. | Pre-computed reference table: 0.3g = tap, 1g = drop from 10cm, 2.5g = drop from 50cm. Lookup, not computation. |
| 3 | **Alert clustering** | "3 alerts in the last 10 minutes" is a pattern. A single alert in 6 hours is an anomaly. Changes the narrative completely. | D1 query: `SELECT COUNT(*) FROM alerts WHERE device_id = ? AND created_at > ?` with a 10-minute window. Agent AI runs this. |
| 4 | **Stationary vs. active at alert time** | Crash while STILL = something hit the device. Crash while ACTIVE = device hit something. Fundamental distinction for interpretation. | First 5 samples of ring buffer: `max(|ω|) < 0.5 rad/s` → STILL. Derivable from the 75×6 samples already stored. Batch processor computes post-hoc. |
| 5 | **Prior similar event** | "This is similar to the bump at 3:15 PM" — pattern recognition. Two crashes in an hour = something's wrong. | D1 query for same classification + same device, nearest in time. Agent AI runs this. |

**MEDIUM IMPACT — add after the above:**

| # | Field | Why it improves answers | Where it comes from |
|---|---|---|---|
| 6 | **Device uptime at alert** | Just rebooted (false alert from sensor initialization) vs. stable for hours (real event). | Already in the telemetry `uptime_ms` field. Edge includes it in the alert frame. |
| 7 | **Telemetry snapshot at alert** | Was the device already tilted? Already vibrating? Pre-event state explains the trigger. | Last `state` frame before the alert timestamp. D1 telemetry query. |
| 8 | **Per-axis a_trans components with plain-language labels** | Instead of raw (1.8, -0.3, 0.9): "Impact from the right side, slightly forward and upward." | Simple axis-to-label mapping. Researcher provides the mapping table. |

**NICE TO HAVE — future iteration:**

| # | Field | Why it improves answers | Where it comes from |
|---|---|---|---|
| 9 | **Timeseries summary** | a_trans min/avg/max over the 75-sample window. Shows whether the impact was a single spike or sustained. | Already computed inside `madgwick()` but not exposed. Add to output if needed. |
| 10 | **Freefall duration** | "Airborne for 0.2 seconds (~20cm drop)" vs. "airborne for 0.04 seconds (brief hop)." Duration calibrates height. | `freefall_samples × 0.04s`. Simple multiplication from the freefall counter inside `madgwick()`. |
| 11 | **Comparison to device history** | "This is the hardest crash this device has ever recorded." | D1 query: `SELECT MAX(json_extract(madgwick_json, '$.max_a_trans')) FROM alerts WHERE device_id = ?`. Agent AI runs this. |
| 12 | **6-bit signature decode** | Raw signature 44 → "side impact with rotation." Useful for unknown classifications where the LLM needs more clues. | 64-entry lookup table. Already designed in §5.5 (simulation signature dictionary). Ship with Edge. |

### 11.4 What Changes in madgwick.ts

For the HIGH IMPACT items, two changes to the current implementation:

1. **Expose freefall duration.** Currently computed internally but not returned. Add `freefall_samples: number` to the output. The chatbot computes duration from it.

2. **Add stationary flag.** Already computed internally (`stationaryBefore` variable). Add `stationary: boolean` to the output. True = device was still when the event started.

Both are already computed inside the loop — just add them to the return object. No new computation. No performance impact.

The remaining high-impact items (impact direction label, baseline multiplier, alert clustering, prior similar event) are computed downstream — by Edge, the batch processor, or Agent AI — from data already in D1. No Madgwick changes needed.

### 11.5 Axes-to-Language Mapping

For impact direction narration. Researcher provides this mapping; Agent AI or Edge applies it.

```
Dominant axis → plain language:
  |a_trans.x| > |a_trans.y| AND |a_trans.x| > |a_trans.z|:
    a_trans.x > 0 → "from the right side"
    a_trans.x < 0 → "from the left side"
  |a_trans.y| dominates:
    a_trans.y > 0 → "from the front"
    a_trans.y < 0 → "from behind"
  |a_trans.z| dominates:
    a_trans.z > 0 → "from below (upward hit)"
    a_trans.z < 0 → "straight down"
  No clear dominant axis (all within 30% of each other):
    → "multi-directional impact"

Add "slightly [direction]" if second-largest component > 50% of largest.
```

### 11.6 Baseline Reference Table

Pre-computed, loaded by Agent AI. Maps a_trans magnitude to human-scale comparisons:

| a_trans (g) | Human-scale comparison | Robot-scale comparison |
|---|---|---|
| < 0.2 | Below sensor noise floor | Probably benign |
| 0.2 – 0.5 | A gentle tap with a fingertip | Desk bump, cable snag |
| 0.5 – 1.0 | A firm poke | Dropped from 2–5 cm |
| 1.0 – 2.0 | A solid shove | Dropped from 10–20 cm, wall bump at low speed |
| 2.0 – 3.0 | Like a book falling flat | Dropped from 30–50 cm, moderate-speed collision |
| 3.0 – 5.0 | A hard fall from desk height | Dropped from 1m+, high-speed wall hit |
| > 5.0 | Violent impact | Thrown, kicked, or fell from >2m |

Agent AI selects the row closest to the measured `|a_trans|` and injects the comparison into the context block.

---

## 12. Embedding Corpus Specification

**For:** Agent AI (vector pipeline owner)
**From:** Agent Researcher

### 12.1 Corpus Architecture — Three Tiers

| Tier | Source | Content | Token count | Embed? | Answers queries like |
|---|---|---|---|---|---|
| **Core** | `signature-analysis.md` full enumeration | 64 signature blocks with Physics, Scenarios, Madgwick, Classification, Source | ~13K | Yes — full embed | "What was that event?" "What does signature 44 mean?" |
| **Physics** | RESEARCHER.md §1.5–1.7 + `signature-analysis.md` triage table + §11.6 baseline table | Why quaternions, adaptive β, MATH_MODEL_REFERENCE, 7-class triage, a_trans→human comparison | ~3K | Yes — for tutor mode | "Why quaternions?" "What does 2.1g feel like?" "What's adaptive β?" |
| **Engineering** | RESEARCHER.md §2, §5, §6, §7, §8 | Implementation surface, simulation framework, ML roadmap, motor physics, Edge coordination, quota, deploy topology | ~8K | No — filename lookup only | "How do we deploy?" "What's the quota?" "What's the alarm pattern?" |

**Total embedded: ~16K tokens.** Embedding cost is negligible at this volume. Total on disk for lookup: ~8K tokens.

### 12.2 Chunking Strategy

**Core tier (64 signature blocks):** Each signature is one chunk. The blocks are already self-contained — Physics, Scenarios, Madgwick, Classification, and Source line. Uniform depth across all 64 (~200 tokens each). No cross-references between signatures (each stands alone). Chunk boundary is the `---` separator and `## N —` heading. Embedding model should use the full block text including the Source line — citations improve retrieval relevance for technical queries.

**Physics tier:** Three chunks:
1. Quaternion rationale + adaptive β (§1.6 + §1.7 combined, ~1,200 tokens)
2. MATH_MODEL_REFERENCE (§1.5, ~300 tokens)
3. Triage table + baseline reference table (from `signature-analysis.md` top + §11.6, ~500 tokens)

**Engineering tier:** Not chunked for embedding. Stored as whole-document files. Retrieved by Agent AI via filename or section heading match, not semantic similarity.

### 12.3 Structured Export

`signature-map.json` at `C:\Projects\FunConnect\Researcher\signature-map.json` provides the authoritative signature→{name, family} mapping in machine-readable form. Version 1.0.0, stable since 2026-07-13. Fields:

```json
{
  "version": "1.0.0",
  "encoding": { "bits": [32,16,8,4,2,1], "labels": ["ax","ay","az","gx","gy","gz"], ... },
  "families": { "noise": {...}, "spin": {...}, ... },
  "signatures": [ {"sig": 0, "binary": "000000", "name": "Silent trigger", "family": "noise"}, ... ]
}
```

Agent AI parses this at startup. No hand-parsing markdown. The JSON is the canonical keys; the markdown in `signature-analysis.md` can evolve without breaking the mapping.

### 12.4 Retrieval Strategy

Per user query:
1. Agent AI receives the alert's `madgwick_json` from D1, including `signature` number
2. If the user asks about the specific event ("what just happened?"): retrieve the signature block by keyed lookup on signature number from `signature-analysis.md` — no embedding needed, exact match
3. If the user asks a general physics question ("why quaternions?"): semantic search over the Physics tier embeddings
4. If the user asks about patterns ("has this happened before?"): Agent AI runs SQL against D1; no embedding retrieval needed
5. If the user asks about deployment: Agent AI reads the Engineering tier by filename

The embedding corpus is for open-ended physics/classification questions, not for event-specific lookups (keyed by signature number) or history queries (SQL). This keeps retrieval lean — the heavy lifting is keyed lookup and SQL, not vector search.

---

## 13. Literature Sources

The 11 sources backing the 64-signature analysis and Madgwick design decisions:

| # | Source | Year | What it provides |
|---|---|---|---|
| 1 | **Haddadin, Albu-Schäffer & Hirzinger** — "Robot Collisions: A Survey" and Danger Index framework | 2008–2017 | Collision severity classification (L1–L4+), mass-normalized thresholds, pre-detection transients, complex impact categories. The foundation for our crash severity tiers. |
| 2 | **Krieg & Ebner** — "Time Series Classification of IMU Data for Point of Impact Localization" (Universität Greifswald) | 2025 | Gyro-only side discrimination at >95% accuracy (Rocket algorithm), 9 impact zones, GZ sign for direction, height classification harder than side. Backs all lateral and corner signatures. |
| 3 | **Valle, Kurdas, Fortunić, Abdolshah & Haddadin** — "Real-time IMU-Based Learning: a Classification of Contact Materials" (TUM) | 2022 | 8 material types via FFT + neural net at 1 kHz, braking vs. collision spectral discrimination, oblique impact angle from pitch-to-acceleration ratio, unsupervised collision window detection. |
| 4 | **Brändle et al.** — "On the effects of angular acceleration in orientation estimation using IMUs" (IEEE) | 2025 | Adaptive β as defense against gravity-leakage false positives, same-axis lever-arm amplification (a_trans overestimation), non-minimum phase zeros from IMU offset. Backs the adaptive β design and the 0.8× severity correction for same-axis pairings. |
| 5 | **Gimpel et al.** — "Evaluation of Threshold-based Fall Detection on Android Smartphones" (University of Potsdam) | 2015 | 15–30% false positive rate from ADLs, <5% with multi-phase state machine, freefall + impact + stillness + orientation change verification. Backs the Ghost crash (56) analysis and the freefall detection design. |
| 6 | **Alhaddad et al.** — "Head Impact Severity Measures for Small Social Robots Thrown During Meltdown in Autism" (Int. J. Social Robotics) | 2019 | Small robot (0.55 kg) impact forces: 3–23g at 2.5–8 m/s, peak accelerations well below adult injury thresholds for sub-kg devices. Backs our severity calibration for the 100g CyberPi. |
| 7 | **Paez-Granados & Billard** — "Crash-testing robots" (Scientific Reports) | 2022 | 62g at 1.5 m/s for kg-scale robots, HIC values in thousands at higher speeds, mass-normalized severity scaling. Used to calibrate crash thresholds from kg-scale to 100g-scale. |
| 8 | **Amazon Technologies** — US Patent 9,689,887 "Monitoring and Characterizing Fall Events" | 2016 | Drop impact zone classification (flat/edge/corner), 1.2–1.5× force amplification for corners, <2% of events account for >40% of failures, skewed flat vs. corner discrimination by yaw absence. Backs the Drop family (8–15). |
| 9 | **Apple Inc.** — US Patent 9,780,621 "Protective Mechanism for an Electronic Device" | 2017 | Mid-fall orientation prediction via gyro axis, Z-gyro during drop = same face impact, X/Y-gyro during drop = changed impact face, random orientation for 3-axis tumble. Backs signatures 9–15 and 63. |
| 10 | **Analog Devices** — ADXL375 Application Note | 2014 | MEMS noise floor: 8× RMS threshold yields 0.006% false trigger rate, ODR vs. internal sampling pitfall, gyro vs. accel bandwidth difference (256 Hz vs. 100 Hz). Backs signature 0 analysis and joint false-trigger probability calculations. |
| 11 | **Endevco** — TP321 "Drop Testing and Shock Response" | — | Peak acceleration from drop height: a = v²/(2×g×d_stop), rigid-body drop physics, stopping distance estimates. Backs the baseline reference table (§11.6). |

Additional supporting sources:
- **Fudickar et al. (2014)** — Freefall threshold standardization (0.5–0.75g, 30ms minimum)
- **Łuczak (2024)** — "IMU6DoF-SST-CNN" — vibration vs. transient discrimination via zero-crossing count, >5 Hz crossover threshold
- **Jansen et al. (2021)** — ML-extended Madgwick with adaptive β switching, RMSE reduction from 11.7° to 7.6°
- **Physics StackExchange (2024)** — Centripetal ω²r derivation, gyroscope independence from IMU mounting offset
- **BiWheel-IMU-Fault dataset** (IEEE DataPort) — Dual-axis gyro rocking mode, periodic fault detection at MPU-6050 frequencies

---

---

## 14. Handoff — Where We Left Off (2026-07-17)

### Done (don't redo)

- **`madgwick.ts`** — shipped and live. Adaptive β (0.96 / 0.0015), 6-class classification, ~5ms in V8. Edge imports it, calls `madgwick(samples)` synchronously in `webSocketMessage()`. 3 enriched alerts confirmed in production (-1.9g to -2.05g). **Do not change the function signature** — `madgwick(samples: number[][]): MadgwickOutput` is the contract.
- **`signature-analysis.md`** — all 64 signatures enumerated with Physics, Scenarios, Madgwick expectations, and literature sources. 11 primary sources + 5 supporting. Complete.
- **`signature-map.json`** — v1.0.0, stable. Machine-readable export for Agent AI. 64 entries, 7 families. **Agent AI has not yet built the keyed reference consumer** — the JSON exists but nobody reads it yet.
- **Prompt spec (§11)** — system prompt, context format, axes-to-language mapping, baseline reference table. Delivered to Agent AI.
- **Embedding corpus spec (§12)** — three-tier architecture (Core/Physics/Engineering), chunking strategy, retrieval strategy. Delivered to Agent AI.
- **Doc audit (2026-07-15)** — all stale "pending" / "Edge needs to" references corrected. Doc now reflects deployed reality throughout.
- **Accelerometer-only classification path (§4.6)** — specified. Threshold-based 3-tier pipeline (threshold → tilt heuristic → temporal proximity), 4-class output, `AccelOnlyOutput` contract with explicit `confidence` field. Separate function `classifyAccelOnly()` — not a degraded Madgwick, but a different classifier for different hardware. Firmware impact: 3-column ring buffer, gyro bits in signature always 0.

### Next in queue — start here

1. **Simulation environment (§5).** This is the top priority. Build the rigid-body simulator, run 10,000 Latin-hypercube-sampled crash trajectories, produce the signature dictionary with per-signature a_trans distributions and classification probabilities. Without this, the ML pipeline has no training data. The spec is complete in §5.2–§5.7 — read those sections, then build.
   - Language choice: Python (NumPy) for speed of development, or Rust (`oxiphysics-rigid` crate) for performance. The compute is trivial either way (~50 seconds for 10K runs).
   - Output: a JSON or SQLite file mapping each of the 64 signatures → { occurrence_rate, a_trans_distribution, classification_probabilities, best_discriminating_feature }.
   - Validation: spot-check 5 signatures against known physics (e.g., sig 0 should be ~0.006% occurrence, sig 63 should produce max a_trans).

2. **Expose `freefall_samples` and `stationary` in MadgwickOutput (§11.4).** Two fields already computed inside `madgwick()` but not returned. Add them to the return object and the `MadgwickOutput` interface. Zero new computation — just add two lines to the return statement. This unblocks richer LLM context for Agent AI.

3. **Implement `classifyAccelOnly()` (§4.6).** The spec is complete. Build the accelerometer-only classifier as a pure TypeScript function — same pattern as `madgwick.ts`: zero awaits, zero bindings, ~5ms target. Deliver as `C:\Projects\FunConnect\Researcher\classify-accel-only.ts`. Edge imports it and routes by device type in `webSocketMessage()`.

4. **ML pipeline (§6).** Blocked on simulation data + ≥200 labeled real alerts. Do not start until simulation is complete. When ready: start with logistic regression baseline (22 features → 6 classes), then random forest, then small feedforward NN. The ML model replaces the decision tree inside `madgwick()` — same function signature, Edge is insulated.

### Open decisions (need Alpha or cross-agent coordination)

| # | Question | Who decides | Where documented |
|---|---|---|---|
| 1 | Simulation language — Python or Rust? | Researcher (pick one) | §5.2 |
| 2 | D1 `signatures` table + admin CRUD for runtime corpus management | Edge + Researcher | AGENTS.md §7 |
| 3 | ~~micro:bit disturbance model — threshold-only path~~ **RESOLVED.** Specified in §4.6. `classifyAccelOnly()` function, 3-tier pipeline, `AccelOnlyOutput` contract. Implementation pending — needs Edge to wire up device-type routing. | Researcher + Edge | §4.6 in this doc |
| 4 | `madgwick_json` per-sample timeseries — worth the 8KB storage cost? | Researcher + Edge | §10, item 2 |
| 5 | Alert deduplication window — firmware 2s cooldown vs. DO-side dedup | Firmware + Edge | §10, item 4 |
| 6 | 7th classification class "spin" for pure rotation events — add or defer? | Researcher | §10, item 8 |

### Files you own

```
C:\Projects\FunConnect\Researcher\
├── RESEARCHER.md              ← this file (handoff at §14)
├── madgwick.ts                ← CANONICAL — do not change signature
├── classify-accel-only.ts     ← TODO — implement from §4.6 spec
├── signature-analysis.md      ← 64-signature reference (read-only)
└── signature-map.json         ← v1.0.0 export (read-only)
```

### Agent dependencies

| You need from | What | Status |
|---|---|---|
| Edge | Alert volume in D1 — need counts to gauge when ≥200 labeled alerts threshold is reached | Ask Alpha for D1 query access |
| Agent AI | Keyed reference lookup consuming `signature-map.json` | Not built yet |
| Firmware | 3-column ring buffer for micro:bit (3-DOF) + 6-bit signature with gyro bits zeroed | Not built yet — see §4.6.6 |
| Beauty | Nothing — dashboard consumes `madgwick_json` and (future) `accel_only_json` from Edge | Stable |

### Quick start for next session

1. Read this handoff (§14).
2. Read §5 (Simulation) — that's your first task.
3. Read `madgwick.ts` (217 lines) — know the function you're building for.
4. Read `signature-map.json` — know the 64 signatures you're simulating against.
5. Tell Alpha you're starting simulation. Build. Run. Report results.

---

*Agent Researcher — July 15, 2026*
