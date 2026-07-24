# 64-Signature Analysis — Full Enumeration

**Encoding:**
```
Bit 5 (32): X accel > 0.40g departure
Bit 4 (16): Y accel > 0.40g departure
Bit 3 (8):  Z accel > 0.40g departure
Bit 2 (4):  X gyro  > 50 °/s
Bit 1 (2):  Y gyro  > 50 °/s
Bit 0 (1):  Z gyro  > 50 °/s
```

**Notation:** `AX` = X accel bit, `AY` = Y accel bit, `AZ` = Z accel bit, `GX` = X gyro bit, `GY` = Y gyro bit, `GZ` = Z gyro bit. Bits written as `[AX AY AZ GX GY GZ]`.

**Coordinate frame:** Z = up/down (gravity ≈ -1g on Z at rest). X = long axis. Y = short axis.

---

## Surface Triage — 7 General Classes

For chatbot first response. Drill into signature name on follow-up.

---

### Noise
**0 signatures, false alarm.** Nothing crossed threshold. Jerk gate fired on compound near-miss or sensor transient. Madgwick: a_trans ≈ 0, omega ≈ 0.

| # | Binary | Name |
|---|---|---|
| 0 | 000000 | Silent trigger |

---

### Spin
**7 signatures, gyro only, no accel.** Pure rotation — desk spins, rocks, wobbles, jolts. No impact. Benign. Madgwick optional (no accel bits means no gravity leakage to resolve).

| # | Binary | Name |
|---|---|---|
| 1 | 000001 | Desk spin |
| 2 | 000010 | Forward nod |
| 3 | 000011 | Diagonal wobble |
| 4 | 000100 | Side rock |
| 5 | 000101 | Coin wobble |
| 6 | 000110 | Table jiggle |
| 7 | 000111 | Brief jolt |

---

### Drop
**8 signatures, Z accel involved.** Vertical events — freefall, landing, lift, edge-drop. Gravity vector shifted along Z. Madgwick important: freefall flag, a_trans on Z separates drop from lift from impact.

| # | Binary | Name |
|---|---|---|
| 8 | 001000 | Clean drop |
| 9 | 001001 | Drop with spin |
| 10 | 001010 | Edge drop |
| 11 | 001011 | Corner drop |
| 12 | 001100 | Side-edge drop |
| 13 | 001101 | Corner drop with roll |
| 14 | 001110 | Flat-edge drop |
| 15 | 001111 | Hard drop |

---

### Bump
**16 signatures, single lateral accel ± gyro.** Push or hit on one face. Off-center hits produce paired gyro. Madgwick important for the no-gyro ones (16, 32): gravity leakage from tilt can fake a lateral push.

| # | Binary | Name |
|---|---|---|
| 16 | 010000 | Short-side tap |
| 17 | 010001 | Short-side clip |
| 18 | 010010 | High side-nudge |
| 19 | 010011 | Short-side slam |
| 20 | 010100 | Side rock |
| 21 | 010101 | Rolling side-hit |
| 22 | 010110 | Tumbling side-hit |
| 23 | 010111 | Violent side-hit |
| 32 | 100000 | Long-side tap |
| 33 | 100001 | Side-swipe |
| 34 | 100010 | High push |
| 35 | 100011 | Pitching side-hit |
| 36 | 100100 | Rolling push |
| 37 | 100101 | Rolling side-swipe |
| 38 | 100110 | Tumbling push |
| 39 | 100111 | Violent side-swipe |

---

### Corner
**24 signatures, two accel axes ± gyro.** Diagonal force — corner impacts at various angles. X+Z, Y+Z, or X+Y plane. Madgwick important for the no-gyro ones (24, 40, 48): gravity leakage from compound tilt can fake a diagonal hit.

| # | Binary | Name |
|---|---|---|
| 24 | 011000 | Diagonal tap |
| 25 | 011001 | Diagonal corner clip |
| 26 | 011010 | Diagonal nose-hit |
| 27 | 011011 | Diagonal corner slam |
| 28 | 011100 | Diagonal roll-hit |
| 29 | 011101 | Diagonal roll-spin |
| 30 | 011110 | Diagonal tumble |
| 31 | 011111 | Diagonal crash |
| 40 | 101000 | Diagonal tap |
| 41 | 101001 | Diagonal clip |
| 42 | 101010 | Nose-down hit |
| 43 | 101011 | Nose-down slam |
| 44 | 101100 | Side-angle hit |
| 45 | 101101 | Side-angle spin |
| 46 | 101110 | Side-angle tumble |
| 47 | 101111 | Diagonal crash |
| 48 | 110000 | Flat corner tap |
| 49 | 110001 | Flat corner clip |
| 50 | 110010 | Corner pitch-hit |
| 51 | 110011 | Corner pitch-spin |
| 52 | 110100 | Corner roll-hit |
| 53 | 110101 | Corner roll-spin |
| 54 | 110110 | Corner tumble |
| 55 | 110111 | Flat crash |

---

### Ghost
**1 signature, three accel axes, zero gyro.** The bits look like a triaxial crash but no rotation registered. Could be a genuine impact through COM (rare) or a fast compound tilt where gravity leaked into all three axes (common). Madgwick REQUIRED — the bits lie.

| # | Binary | Name |
|---|---|---|
| 56 | 111000 | Ghost crash |

---

### Crash
**7 signatures, three accel axes + gyro.** Confirmed violent multi-axis impact. Hard collision, drop from height, or tumble. Madgwick confirms severity but classification is not in doubt.

| # | Binary | Name |
|---|---|---|
| 57 | 111001 | Triaxial yaw-crash |
| 58 | 111010 | Triaxial pitch-crash |
| 59 | 111011 | Triaxial pitch-spin crash |
| 60 | 111100 | Triaxial roll-crash |
| 61 | 111101 | Triaxial roll-spin crash |
| 62 | 111110 | Cartwheel crash |
| 63 | 111111 | Full crash |

---

**Triage summary:**

| Class | Count | Madgwick needed? | Chatbot tone |
|---|---|---|---|
| Noise | 1 | Confirm near-zero | "Nothing meaningful detected." |
| Spin | 7 | Optional | "The device was rotated — no impact." |
| Drop | 8 | Important | "The device went airborne. Check its position." |
| Bump | 16 | Important on no-gyro | "Light contact detected — probably a tap or nudge." |
| Corner | 24 | Important on no-gyro | "Something hit the device at an angle." |
| Ghost | 1 | REQUIRED | "This one's ambiguous. Checking the sensor fusion..." |
| Crash | 7 | Confirms severity only | "Hard impact detected. Check the device." |

---

## Full Enumeration — All 64 Signatures

For deep inspection. Each signature with binary, physics, Madgwick expectation, and classification.

---

## 0 — 000000 — [— — — — — —]

No axis crossed threshold. The jerk gate fired but no single DOF exceeded its limit.

**Physics:** The jerk gate is a per-axis 2nd-order derivative — it amplifies transients. A brief noise spike or compound near-threshold event can fire the gate without any single axis crossing its amplitude threshold. MEMS accelerometers (MPU-6050 class) have Gaussian noise. Industry practice (ADXL375 application note) specifies an 8× RMS threshold for shock detection, yielding a false trigger rate of ~0.006% per sample. At 25 Hz, that is roughly one false trigger every 11 minutes of continuous monitoring. A "silent trigger" occurs when the jerk derivative amplifier catches a noise spike that doesn't sustain long enough to register in any axis threshold. A duration gate — requiring the signal to stay above threshold for N consecutive samples — is the standard mitigation. Our 75-sample ring buffer provides this implicitly.

**Madgwick:** a_trans ≈ 0, omega ≈ 0. Essentially noise.
**Classification:** unknown. If these accumulate in D1 beyond the expected ~130/day baseline (0.006% × 25 Hz × 86,400 s), the jerk gate threshold needs raising or a minimum-amplitude pre-filter should be added. The ADXL375 datasheet documents the "ODR vs. internal sampling" pitfall — if the output data rate is too low relative to internal sampling, interrupts can fire on high-frequency data that never appears in the output registers. At 25 Hz ODR, this is unlikely but possible for very brief (<40ms) shock transients.

**Source:** ADXL375 application note, "Peak-to-Peak Noise Estimation" — 8× RMS threshold, 0.006% false trigger rate. Gimpel et al. (2015), "Evaluation of Threshold-based Fall Detection on Android Smartphones" — false positives without freefall phase: 15–30%.

---

## 1 — 000001 — [— — — — — GZ]

Only Z gyro crossed. No accel, no X/Y gyro.

**Physics:** Pure yaw rotation. The device spun around its vertical axis. All accelerometer axes stayed below 0.40g. The centripetal term at the IMU, `a = ω × (ω × r)`, for ω = 0.87 rad/s (50 °/s) and r = 2 cm, yields only 0.0015g — two orders of magnitude below the 0.40g accel threshold. A pure spin would need ~430 °/s (45 rad/s) at 2 cm offset to produce 0.40g centripetal — speeds the CyberPi never reaches. Additionally, gyroscope readings are independent of IMU mounting offset: angular velocity is identical at every point on a rigid body. Only the accelerometer needs offset compensation. The absence of accel bits in this signature is physically guaranteed, not a sensor artifact.

**Scenarios:** Desk spin — someone rotated the device on the table. Stuck mBot2 wheel — one motor running, chassis jammed, reaction torque spins chassis. The device remains flat throughout (Z still near -1g, X and Y near zero). Benign.

**Madgwick:** a_trans ≈ 0. Omega mostly on Z. Roll/pitch unchanged — device stayed flat. Δyaw accumulates but is unobservable without a magnetometer. The total yaw angle integrated from GZ is reliable for ~10–20 seconds before gyro bias drift becomes significant (~0.1 °/s typical for MPU-6050, accumulating ~1° error after 10s).

**Source:** Physics StackExchange, "Off-centered IMU and centripetal force" (2024) — ω²r = 0.0015g at 50 °/s, 2 cm. UIO lecture notes on inertial navigation — gyroscope mounting offset independence.

---

## 2 — 000010 — [— — — — GY —]

Only Y gyro crossed.

**Physics:** Brief pitch rotation around Y — the device nodded forward or backward. For the gravity vector to stay within 0.40g of its resting position on Z, the pitch angle must remain below ~23° (sin⁻¹(0.40/g) ≈ 23.6°). At 50 °/s, crossing 23° takes ~460 ms — but if the pitch was a brief jerk (high angular acceleration, low sustained velocity), the angle never reaches 23° before rotation stops. The angular jerk fired the gate, but total displacement stayed small. The Gimpel et al. (2015) fall detection study classifies small-angle tilts (<30°) as "ADL" — activities of daily living: picking up, adjusting, reorienting the device. Not a fall, not a crash.

**Scenarios:** Brief forward/backward rock. mBot2 accelerating/decelerating — the chassis pitches from motor torque reaction. A tap on the top edge causing a quick nod. Device being picked up or repositioned. The total pitch angle from Madgwick confirms whether orientation changed meaningfully.

**Madgwick:** Small Δpitch. a_trans near zero. If Δpitch < 5° → unknown (below meaningful threshold). If 5° < Δpitch < 23° → tilt (slight reorientation). If Δpitch > 23° → would have triggered AX from gravity leakage; the absence of AX confirms the pitch stayed small.
**Classification:** tilt or unknown.

**Source:** Gimpel et al. (2015) — orientation change <30° classified as ADL, not fall. Krieg & Ebner (2025) — gyro-only events distinguish tilt from impact.

---

## 3 — 000011 — [— — — — GY GZ]

Y gyro + Z gyro only. No accel.

**Physics:** Dual-axis small-angle rotation — pitch + yaw, a corkscrew motion. The BiWheel-IMU-Fault dataset (IEEE DataPort) documents that dual-axis gyro without accel characterizes "rocking mode" — the device pivots on a contact point but doesn't translate. The absence of accel bits means total angular displacement stayed under ~23° on both rotation axes (otherwise gravity leakage would trigger accel bits — similar geometry to signature 2). If the omega magnitude is decaying across the 75-sample window (exponential decay constant τ < 1s), the device is settling after being placed down. If periodic (≥6 zero-crossings in either gyro axis), it is environmental vibration.

**Scenarios:** Diagonal nudge producing compound rotation. Device settling on an uneven surface after being placed down. Corner tap — brief contact producing dual-axis spin without enough linear force to trigger accel.

**Madgwick:** Small multi-axis Δorientation. a_trans ≈ 0. The omega decay profile discriminates settling (decaying exponential) from active spin (sustained or rising).
**Classification:** tilt if Δorientation > 5°. unknown if below. vibration if periodic.

**Source:** BiWheel-IMU-Fault dataset (IEEE DataPort) — dual-axis gyro rocking mode. Łuczak (2024), "IMU6DoF-SST-CNN" — periodic vs. transient discrimination via zero-crossing count.

---

## 4 — 000100 — [— — — GX — —]

Only X gyro crossed. No accel, no Y/Z gyro. Mirror of signature 2 around the X axis — roll instead of pitch.

**Physics:** Brief roll rotation — the device rocked side-to-side around its long axis. Same 23° angle constraint as signature 2: the roll stayed small enough that gravity didn't visibly leak from Z to Y. At a roll angle θ, the Y-axis acceleration change is ΔAY = g × sin(θ). For ΔAY to stay below 0.40g, θ must remain below ~23°. At 50 °/s, crossing 23° takes ~460 ms — but the gyro bit fired from angular jerk, not sustained velocity. The total roll angle never reached 23° before the rotation stopped. The Krieg & Ebner (2025) side-impact classification study found that pure roll without translation is characteristic of a "rocking settle" — the device is finding its stable orientation on an uneven surface through micro-rocking. The roll sign (positive vs. negative GX) tells you which side rocked up: positive = right side lifted, negative = left side lifted.

**Scenarios:** Side rock on an uneven surface. Device placed down and settling — one edge contacts first, then the chassis rocks to find both contact points. Someone nudged one side of the device. The device was standing on its narrow edge and rocked slightly but didn't tip over — a full 90° tip would trigger AY and AZ from the massive gravity shift. Their absence confirms the roll was small-angle.

**Madgwick:** Small Δroll. a_trans ≈ 0 (no real impact, just rotation). GX sign gives direction: positive = rocked right, negative = rocked left. If Δroll < 5° → below meaningful threshold (unknown). If 5° < Δroll < 23° → tilt (measurable reorientation). If Δroll > 23° → would have triggered AY — the absence of AY confirms small-angle.
**Classification:** tilt if Δroll > 5°. unknown if below.

**Source:** Krieg & Ebner (2025) — pure roll = rocking settle, gyro sign determines direction (95% accuracy for side discrimination). Gimpel et al. (2015) — orientation change <30° classified as ADL, not fall.

---

## 5 — 000101 — [— — — GX — GZ]

X gyro + Z gyro only. No accel.

**Physics:** Roll + yaw combined — a coin wobbling before it settles flat. Both rotation axes active, small angles. The literature describes this as "pre-settle wobble" — the device was placed down but hasn't stabilized. The characteristic is decaying amplitude in both gyro axes as the device's base makes multiple micro-contacts with the surface. The exponential decay constant τ discriminates settling (τ < 1s, surface damping) from active driven motion (τ > 1s or rising, someone still touching it). At our 3-second window (75 × 0.04s), the decay is fully observable.

**Scenarios:** Device placed down hastily and wobbling. Uneven table surface — device oscillates before finding stable contact. Loose bearing or slightly warped chassis — always wobbles slightly after any disturbance. Wobble after a desk spin — the device was spun and it is now precessing as it slows.

**Madgwick:** Small Δroll. Yaw unobservable. a_trans ≈ 0. Decay analysis on omega magnitude: fit exponential, extract τ.
**Classification:** tilt (if Δorientation measurable). unknown (if purely oscillatory with no net orientation change).

**Source:** Inertial navigation texts — rigid body settling dynamics, exponential decay on flat surfaces. BiWheel-IMU-Fault dataset — pre-settle oscillation characterization.

---

## 6 — 000110 — [— — — GX GY —]

X gyro + Y gyro only. No accel, no Z gyro.

**Physics:** Roll + pitch — a circular wobble with no spin. Both tilt axes rocking, Z axis not rotating. This is the signature of a device oscillating in place on a slightly uneven surface. Unlike signature 5, there is no yaw (no GZ), so the motion is purely in the tilt plane. The key discrimination from the Łuczak (2024) vibration classification paper: if the roll/pitch gyro signals show a periodic pattern with >6 zero-crossings in the 75-sample window, it is sustained environmental vibration (motor nearby, heavy footsteps, washing machine). If it is a single damped oscillation with <6 zero-crossings, it is a transient table bump.

**Scenarios:** Circular wobble on uneven surface. Someone jiggled the table. Device settling after a bump. If periodic → vibration from external source (not a device event). If transient → table jiggle from a nearby impact.

**Madgwick:** Small Δroll + Δpitch. a_trans ≈ 0. Zero-crossing count on gyro signals discriminates periodic from transient.
**Classification:** vibration (periodic, >6 zero-crossings). tilt (transient, <6 zero-crossings, Δorientation > 5°). unknown (transient, no net orientation change).

**Source:** Łuczak (2024), "IMU6DoF-SST-CNN" — vibration vs. transient via zero-crossing count. BiWheel-IMU-Fault dataset — periodic fault detection thresholds at ~5 Hz crossover.

---

## 7 — 000111 — [— — — GX GY GZ]

All three gyro axes. No accel at all.

**Physics:** Chaotic multi-axis rotation but gravity stayed within 0.40g of resting on every accel axis. The rotations are either very small-angle, or so brief that orientation hasn't shifted significantly. The Haddadin collision detection pipeline (2017) identifies this pattern as a "pre-detection transient" — a vibration wave traveling through the chassis from a remote impact. The gyros in most MEMS packages have wider bandwidth than the accelerometers (256 Hz vs. 100 Hz typical for MPU-6050 family), so a very brief mechanical shock (<10ms) can trigger gyro bits without the accelerometer registering above threshold. The ADXL375 datasheet documents this: mechanical shock produces a high-frequency burst that the gyro's wider bandwidth captures but the accelerometer's anti-aliasing filter attenuates. If the omega spike duration is <50ms (1–2 samples at 25 Hz), it is a shock transient — not rotation of the device. If >100ms (3+ samples), it is actual multi-axis tumble. At 25 Hz, we have 40ms resolution per sample, sufficient to distinguish these.

**Scenarios:** Table hit from below — shock travels through surface into chassis. Something heavy dropped nearby. Door slam — pressure wave vibrates the table. Indirect impact — the device wasn't hit, but the surface it sits on was. Brief multi-axis jolt — device was briefly airborne (<40ms, not captured as freefall).

**Madgwick:** Omega spike is brief. a_trans small but may show vibration pattern. Δorientation minimal. Pulse width discrimination: <2 samples = shock transient, ≥3 samples = actual tumble.
**Classification:** vibration (if sustained across window). bump (if a_trans is borderline from chassis flex). unknown (if brief transient with no follow-through).

**Source:** Haddadin, De Luca & Albu-Schäffer (2017), "Robot Collisions: A Survey" — pre-detection transients, indirect impact via surface. ADXL375 datasheet — gyro vs. accel bandwidth difference (256 Hz vs. 100 Hz), mechanical shock propagation.

---

## 8 — 001000 — [— — AZ — — —]

Only Z accel crossed. No other accel, no gyro. The cleanest single-axis signature.

**Physics:** At rest, Z ≈ -1g (gravity). A 0.40g departure means Z either dropped toward 0 (freefall — gravity vanishing, |ΔZ| ≈ 1g), spiked more negative (downward impact), or spiked positive (upward lift). No gyro bits means the device stayed perfectly level throughout — no pitch, no roll, no yaw. No X/Y accel means no lateral force. This constrains the event to a pure vertical axis. The fall detection literature (Fudickar et al. 2014, Gimpel et al. 2015) standardizes freefall detection at |a| < 0.5g or 0.75g for ≥30ms. Our 0.35g is more aggressive. Our 4-sample minimum at 40ms/sample = 160ms minimum freefall, which is conservative relative to the 30ms literature threshold — good for false-positive suppression. The false-positive risk without a freefall phase check is 15–30% (Gimpel et al. 2015); with it, <5%.

**Scenarios:** Freefall onset — device dropped flat, Z→0, no rotation. Flat landing — device landed perfectly on its base, Z spikes downward. Vertical lift — picked straight up, Z positive. Table hammered from below — vertical shockwave through chassis.

**Madgwick:** The freefall flag is the critical discriminator. If |a_raw| < 0.35g for ≥4 consecutive samples → freefall. If impact → a_trans is mostly on Z (positive or negative), roll/pitch near zero. If lift → a_trans on Z, positive, gradual onset (low jerk), not an impact. Tilt is physically impossible here — no gyro bits means no orientation change occurred.
**Classification:** freefall (if freefall flag set). crash (if high a_trans on Z from landing — Alhaddad et al. 2019: a 50cm drop produces ~10g peak on a hard surface for a 100g device). bump (if moderate Z impact < 1.5g).

**Source:** Fudickar et al. (2014) — freefall threshold 0.5–0.75g, 30ms minimum. Gimpel et al. (2015) — false-positive rate 15–30% without freefall phase, <5% with. Alhaddad et al. (2019) — small device drop impacts 3–23g.

---

## 9 — 001001 — [— — AZ — — GZ]

Z accel + Z gyro. Vertical force with yaw rotation.

**Physics:** The device experienced an up/down event while spinning around Z. The Apple patent US 9,780,621 ("Protective Mechanism for an Electronic Device") classifies drop orientation by gyro axis: Z gyro (yaw) during a drop does NOT change which face hits the ground — the device still lands on the same face, just rotated. X or Y gyro (pitch/roll) during a drop DOES change the impact face. So signature 9 (Z gyro only) is still a flat landing — just a spinning flat landing. The impact face is predictable from the pre-drop orientation. The Amazon patent US 9,689,887 confirms: flat impacts produce the lowest local stress (large contact area). Spinning adds complexity but doesn't change the impact zone classification.

**Scenarios:** Drop with pre-existing spin — device was rotating on the table, then fell off. Freefall (Z accel) + continued spin (Z gyro). Off-center vertical impact — something hit the device from above at a point that produced Z torque but no pitch/roll. Lifted and twisted — picked up while rotated.

**Madgwick:** a_trans on Z. Omega on Z. Roll/pitch near zero — device stayed flat. If freefall flag set → dropped while spinning. The GZ magnitude indicates spin rate at impact; higher GZ means the device was spinning faster when it hit.
**Classification:** crash (high a_trans + high omega — spinning vertical impact, Haddakin L2–L3 for small devices). freefall (if freefall flag). bump (moderate a_trans, low omega).

**Source:** Apple US 9,780,621 — Z gyro during drop = same face impact. Amazon US 9,689,887 — flat impacts = lowest local stress. Endevco TP321 — peak g from drop height for rigid bodies.

---

## 10 — 001010 — [— — AZ — GY —]

Z accel + Y gyro. Vertical force with pitch rotation.

**Physics:** The vertical force was off-center in the X direction (forward/backward from COM), producing pitch torque. The Amazon patent maps this to an edge drop — the device tips over a table edge, pivoting around the edge. The gyro axis identifies WHICH edge: Y gyro = device pitched forward/backward, so the pivot was the X-aligned edge (front or back lip of the table). The Gimpel et al. (2015) study notes edge drops are the most confusable with ADLs — picking up a device from a table produces a similar pitch-then-lift profile. The discriminator: edge drop has freefall after rotation; pickup does not. Our freefall flag separates these. The angular velocity during the tip-over gives drop height: ω × r_edge = linear velocity at departure from the table.

**Scenarios:** Edge drop — device fell off the front or back of a table, pitched as it went over. Slap from above at front/back edge — hand comes down producing Z force + Y rotation. Landing on front/back edge first, then chassis slaps down. The pitch sign tells direction: positive GY = nose-down pitch, negative = nose-up.

**Madgwick:** a_trans on Z. Omega on Y (pitch). Δpitch should be non-zero. Roll near zero. If a_trans is low AND Δpitch is significant → the Z departure was gravity rotating during pitch, not a real impact (tilt, not crash). If a_trans is high + Δpitch confirmed → real edge impact.
**Classification:** crash (high a_trans), tilt (low a_trans, Δpitch > 15°), bump (moderate a_trans).

**Source:** Amazon US 9,689,887 — edge pivot detection via gyro axis. Gimpel et al. (2015) — ADL confusion with edge-drop (pickup vs. drop discrimination).

---

## 11 — 001011 — [— — AZ — GY GZ]

Z accel + Y gyro + Z gyro. Three bits. Vertical force with pitch + yaw.

**Physics:** Off-center vertical impact producing rotation around two axes — the device pitched AND yawed from the impact. The Amazon patent classifies this as a corner drop: two gyro axes active means the device rotated around two axes during the fall, indicating a corner pivot — the device tipped off a corner of the table, producing compound rotation. Corner impacts produce the highest local stress (small contact area = high pressure) and are the most damaging orientation for a small device. The Apple patent confirms: at this rotation complexity, the impact face is partially predictable — the pitch axis tells you whether the front/back or left/right face took the majority of the force, but the corner contact means the force is concentrated on a small area.

**Scenarios:** Corner drop — device fell off a table corner, pitched and yawed. Diagonal edge impact from above at a corner. Device landed on a corner from a drop — the worst-case impact geometry for structural damage. Device was slapped from above near a corner.

**Madgwick:** a_trans on Z. Omega on Y and Z. Roll near zero. The corner geometry means a_trans is amplified relative to a flat impact at the same drop height — Amazon data shows 1.2–1.5× higher peak force for corner vs. flat impacts.
**Classification:** crash (high a_trans — corner impacts concentrate force). bump if a_trans is surprisingly low (landed on something soft).

**Source:** Amazon US 9,689,887 — corner impacts = highest local stress, 1.2–1.5× force amplification. Apple US 9,780,621 — multi-axis rotation = corner or edge impact, partially predictable impact face.

---

## 12 — 001100 — [— — AZ GX — —]

Z accel + X gyro. Vertical force with roll rotation. Mirror of signature 10 around the X axis.

**Physics:** The vertical force was off-center in the Y direction (left/right of COM), producing roll torque. Identical physics to signature 10 but the pivot edge is the Y-aligned edge (left or right lip of the table). X gyro = device rolled sideways, so the pivot was the left or right edge. The Amazon patent's edge classification applies identically: the gyro axis identifies which edge was the pivot. The roll sign tells direction: positive GX = rolled right side down, negative = rolled left side down.

**Scenarios:** Side-edge drop — device fell off the left or right side of a table. Slap on left/right edge from above — Z force + X rotation. Landing on left/right edge first, then chassis slaps down. The roll sign is directionally diagnostic — it tells you which side of the table the device fell from.

**Madgwick:** a_trans on Z. Omega on X (roll). Δroll non-zero. Pitch near zero. Same discrimination as 10: a_trans vs. Δorientation separates real impact from gravity leakage during roll.
**Classification:** crash (high a_trans), tilt (low a_trans, Δroll > 15°), bump (moderate).

**Source:** Amazon US 9,689,887 — edge pivot detection via gyro axis, gyro sign = pivot edge direction. Krieg & Ebner (2025) — gyro sign for side discrimination at >95% accuracy.

---

## 13 — 001101 — [— — AZ GX — GZ]

Z accel + X gyro + Z gyro. Three bits. Vertical force with roll + yaw.

**Physics:** Off-center vertical impact producing rotation around X and Z. The device rolled AND yawed — a corner drop where the pivot corner produced compound rotation in both the roll and yaw axes. Identical geometry to signature 11 but the roll axis (X) is engaged instead of pitch (Y). The Amazon patent: corner impacts with two gyro axes active are classified as corner-zone impacts with high confidence. The specific gyro pairing (X+Z vs. Y+Z) identifies WHICH corner: X+Z = left or right corner (roll + yaw), Y+Z = front or back corner (pitch + yaw).

**Scenarios:** Corner drop — device fell off a left or right corner, rolling and yawing. Off-center vertical impact near a corner. Device landed on a side corner from a drop.

**Madgwick:** a_trans on Z. Omega on X and Z. Pitch near zero. Same 1.2–1.5× force amplification as signature 11 from corner contact geometry.
**Classification:** crash or bump. Corner impacts are inherently higher severity than flat impacts at the same drop height.

**Source:** Amazon US 9,689,887 — corner zone identification by gyro axis pairing. Apple US 9,780,621 — multi-axis rotation during freefall predicts impact zone.

---

## 14 — 001110 — [— — AZ GX GY —]

Z accel + X gyro + Y gyro. Three bits. No Z gyro. Vertical force with roll + pitch, no yaw.

**Physics:** Both tilt axes engaged from a vertical impact, but Z gyro absent — the device pitched AND rolled without spinning. The Amazon patent classifies this as a "skewed flat" landing — the device contacted the surface with its face but at an angle, producing both pitch and roll rotation from the asymmetric normal force, but no yaw because the force vector passed through or near the Z axis. This occurs when the device was already tilted before release, or when the landing surface isn't level. The absence of yaw distinguishes this from a corner drop — corner drops almost always produce some yaw from the asymmetric reaction force (Amazon patent data: <5% of corner impacts have zero yaw). This is more likely a flat drop with an initial tilt.

**Scenarios:** Device dropped while already tilted — the initial pitch/roll carried through the fall, producing compound rotation on landing. Landing on an uneven or angled surface. Device landed flat but on a surface that wasn't level (angled desk, sloped floor).

**Madgwick:** a_trans on Z. Omega on X and Y. No Z omega. The pre-impact orientation from Madgwick confirms whether the device was tilted before the event. The absence of yaw makes corner impact less likely — this is a flat impact with attitude.
**Classification:** crash (high a_trans, compound tilt), bump (moderate).

**Source:** Amazon US 9,689,887 — skewed flat vs. corner discrimination by yaw absence (<5% corner events lack yaw).

---

## 15 — 001111 — [— — AZ GX GY GZ]

Z accel + all three gyro axes. Four bits. The hardest drop signature.

**Physics:** Vertical impact with chaotic multi-axis rotation — the device tumbled through all three rotation axes during the event. In the Haddadin collision severity framework (2008–2017), a 4-bit event with all gyro axes engaged maps to "complex impact" — moderate-to-severe at minimum. The Amazon patent data: when all three gyro axes are active during a drop, the device's orientation at impact is effectively random — no single face is predictable, the damage pattern is diffuse. For a 100g CyberPi dropped from table height (50cm), the peak acceleration is ~10g on a hard surface (Endevco TP321, Alhaddad et al. 2019). The Paez-Granados & Billard (2022) crash-testing data: a 1.5 m/s impact (equivalent to a 12cm drop) on a small device produces ~62g at kg-scale, scaling to ~10–15g for our 100g device. Hard, but the device survives.

**Scenarios:** Dropped from height (>50cm) onto a hard surface — hits on a corner, bounces, tumbles. Knocked off a table with spin — the initial angular momentum carries through. Thrown or tossed — airborne with complex rotation. The hardest drop the device can experience short of being thrown.

**Madgwick:** a_trans on Z (dominant), with X and Y components from the tumbling. High omega on all three gyro axes. Large Δorientation. Freefall flag likely set before impact. Severity confirmed.
**Classification:** crash — near-certain. This signature should never produce "bump" or "tilt." Four bits with all gyro axes = unambiguous high-energy event.

**Source:** Haddadin et al. (2008) — complex impact, 4-bit = moderate-to-severe. Alhaddad et al. (2019) — small robot thrown impacts 3–23g. Paez-Granados & Billard (2022) — 62g at 1.5 m/s, scaled to 10–15g for 100g. Amazon US 9,689,887 — 3-axis gyro = random impact orientation.

---

## 16 — 010000 — [— AY — — — —]

Only Y accel crossed. No Z, no X, no gyro. The highest-stakes ambiguity in the Bump family.

**Physics:** Pure lateral force on the short axis, dead center — something pushed the device sideways with zero torque. OR gravity leakage from roll around X — device rolled, gravity shifted from Z to Y. The Brändle et al. (2025) Madgwick filter analysis identifies this exact scenario: when `|a|` deviates from 1g (as it does during both a real push and a tilt), the filter's gradient descent step steers orientation toward the acceleration vector instead of true gravity. The defense is adaptive β: during a real push, β stays low (0.0015) because |a| ≠ 1g, gyro integration preserves true orientation, and a_trans correctly shows lateral force. During a slow tilt where |a| ≈ 1g, β stays high (0.96), the filter tracks the tilt, and a_trans ≈ 0. The Krieg & Ebner (2025) data: pure lateral acceleration without rotation is rare in practice — most real-world side contacts have a vertical offset, producing at least one gyro bit. A genuine signature 16 occurs in <10% of lateral impacts.

**Scenarios:** Side nudge on the short face — clean center-of-mass push. Gravity leakage from small roll — device rolled slightly, leaked gravity into Y, but angular velocity stayed below 50 °/s. Sliding friction stop — device was sliding sideways and stopped abruptly. The absence of gyro means either perfect COM hit (rare) or tilt without sustained rotation (common).

**Madgwick:** If a_trans on Y > 0.3g → real lateral impact. If a_trans ≈ 0 + Δroll > 5° → tilt, not impact. If a_trans ≈ 0 + Δroll < 5° → false alarm (no real force, no real rotation — noise-level).
**Classification:** bump (real impact, a_trans > 0.3g). tilt (gravity leakage, a_trans ≈ 0, Δroll > 5°). unknown (neither, false alarm).

**Source:** Brändle et al. (2025) — adaptive β for gravity-tilt decoupling at |a| ≠ 1g. Krieg & Ebner (2025) — pure lateral accel without gyro is <10% of lateral impacts.

---

## 17 — 010001 — [— AY — — — GZ]

Y accel + Z gyro. Side hit on the short face with yaw.

**Physics:** Off-center hit on the Y face producing Z torque. The impact landed left or right of COM on the short face, causing the device to yaw. Krieg & Ebner (2025) demonstrated experimentally: the Z-gyro SIGN is the single most discriminative feature for side classification — >95% accuracy using gyro-only data with the Rocket algorithm on 9 impact zones. Positive GZ = hit from one side, negative = hit from the other. The GZ MAGNITUDE correlates with off-center distance: larger |GZ| = further from COM = more leverage. The Valle et al. (2022) contact material study adds: the GZ profile's spectral content encodes the material struck — hard surfaces (metal, wall) produce broadband excitation up to 500+ Hz; soft surfaces (foam, hand) have narrower spectra. At 25 Hz we are Nyquist-limited to 12.5 Hz for spectral analysis, but the peak GZ magnitude still carries material information.

**Scenarios:** Side-swipe on the short face — clipped while moving. Corner impact on the Y face — near the edge, producing yaw. Robot clipped on the side and spinning. The GZ sign tells direction: positive = hit from left, negative = hit from right (depending on coordinate convention).

**Madgwick:** a_trans on Y. Omega on Z. GZ sign gives hit direction, GZ magnitude gives off-center distance, AY magnitude gives impact force. Three numbers completely characterize the geometry.
**Classification:** crash (high a_trans + high omega — spinning collision, Haddakin L2–L3 for small devices). bump (moderate).

**Source:** Krieg & Ebner (2025) — GZ sign >95% accuracy for side discrimination. Valle et al. (2022) — gyro magnitude correlates with off-center distance, spectral profile encodes material.

---

## 18 — 010010 — [— AY — — GY —]

Y accel + Y gyro. Force and rotation around the same axis.

**Physics:** Lateral force on Y with pitch rotation around the same Y axis. The force was applied above or below COM on the Y face, producing Y translation + Y rotation. The Brändle et al. (2025) paper on angular acceleration effects specifically addresses same-axis force+rotation: the IMU lever-arm effect is maximized. Tangential acceleration `α × r` from angular acceleration around Y produces additional Y-axis acceleration at the IMU. This means the measured AY is force + angular artifact, not pure force. The a_trans measurement on Y may be OVERESTIMATED — the gyro-induced tangential acceleration adds to the real impact force. Severity should be slightly downgraded for same-axis pairings compared to orthogonal pairings like 17 (AY+GZ) or 20 (AY+GX). The Krieg & Ebner study found height classification (above vs. below COM) is harder than side classification — accuracy drops because the gyro signal for "hit high" vs. "hit low" is more subtle. The pitch sign gives height: positive GY = hit above COM (nose-down pitch), negative = hit below COM (nose-up pitch).

**Scenarios:** High hit on the short face — force above COM, device pitches forward. Low hit — force below COM, device pitches backward. Off-height side push — the vertical offset from COM created a pitch moment.

**Madgwick:** a_trans on Y (potentially overestimated due to lever-arm amplification). Omega on Y. Δpitch non-zero. GY sign gives hit height.
**Classification:** bump or crash. Severity slightly downgraded vs. signatures 17/20 due to same-axis lever-arm amplification.

**Source:** Brändle et al. (2025) — same-axis force+rotation lever-arm amplification of a_trans. Krieg & Ebner (2025) — height classification harder than side.

---

## 19 — 010011 — [— AY — — GY GZ]

Y accel + Y gyro + Z gyro. Three bits. Off-center, off-height hit on the Y face.

**Physics:** Complex side impact — the force landed off-center (GZ = yaw) AND off-height (GY = pitch) on the short face. Krieg & Ebner (2025): three-zone hits with multiple gyro axes engaged have the highest classification confidence (>95%) because they engage distinct features in both accel and gyro domains. The specific pairing identifies the impact zone: GY+GZ means the hit was both to one side (yaw) and above/below COM (pitch) — a "corner of the face" impact. The Valle et al. (2022) oblique impact data: the ratio of GY to GZ magnitude reveals whether the impact was more side-offset (GZ dominant) or more height-offset (GY dominant).

**Scenarios:** Diagonal hit on the short face — near a corner, producing both pitch and yaw. Device struck at an angle on the Y face. Complex side impact with both lateral offset and vertical offset.

**Madgwick:** a_trans on Y. Omega on Y and Z. GY/GZ ratio gives impact geometry. Higher bit count elevates severity.
**Classification:** crash (high a_trans + multi-axis omega). bump (moderate).

**Source:** Krieg & Ebner (2025) — 3-zone hits with multiple gyro axes: >95% classification confidence. Valle et al. (2022) — gyro axis ratio for impact angle.

---

## 20 — 010100 — [— AY — GX — —]

Y accel + X gyro. The most natural Y-impact pairing.

**Physics:** Lateral force on the short face with roll rotation around X. The force was off-center in Z (below COM typically), producing Y translation + X rotation. This is the CANONICAL off-center side impact — the force and rotation axes are orthogonal, meaning no lever-arm amplification (unlike signature 18). Krieg & Ebner (2025) classify this as "mid-height side impact" — the force was low enough on the face to produce significant roll without triggering additional accel axes. The X-gyro magnitude correlates with how far below COM the hit landed: larger |GX| = further from COM = more leverage. The GX sign tells direction: positive = hit on one side producing roll in that direction.

**Scenarios:** Side hit on the Y face below COM — device pushed sideways AND rocks. Very common — most real-world side contacts have some vertical offset from COM. Device on a table, bumped from the side by a hand, rocks slightly. The absence of AZ means the roll was small enough that Z departure stayed below 0.40g (roll angle < ~23°).

**Madgwick:** a_trans on Y. Omega on X. GX sign gives roll direction. No lever-arm amplification (orthogonal axes). Severity is more reliable than signature 18.
**Classification:** crash (high a_trans + high omega). bump (moderate). tilt (low a_trans, Δroll significant — the Y accel was gravity leakage during roll).

**Source:** Krieg & Ebner (2025) — mid-height side impact, orthogonal axis pairing, 95% accuracy. Brändle et al. (2025) — orthogonal axes = no lever-arm amplification.

---

## 21 — 010101 — [— AY — GX — GZ]

Y accel + X gyro + Z gyro. Three bits. Complex off-center hit on the Y face.

**Physics:** Lateral Y force with roll AND yaw — the impact landed off-center in TWO directions (left/right for yaw, above/below for roll). The Krieg & Ebner 9-zone classification maps this to a diagonal corner of the Y face — the force was off-center in both the horizontal and vertical directions. Three-bit events with orthogonal gyro axes have very high classification confidence. The GX/GZ ratio reveals impact geometry: GX dominant = more vertical offset, GZ dominant = more horizontal offset.

**Scenarios:** Corner-of-face impact — hit near a corner of the Y face. Device struck at an angle combining side force, roll, and yaw. Complex side-swipe with both lateral and vertical offset from COM.

**Madgwick:** a_trans on Y. Omega on X and Z. GX sign + GZ sign together give the exact impact quadrant on the Y face.
**Classification:** crash (high a_trans). bump (moderate, but multi-axis gyro elevates severity vs. 2-bit side hits).

**Source:** Krieg & Ebner (2025) — multi-axis gyro = highest classification confidence. Valle et al. (2022) — gyro axis ratio reveals impact quadrant.

---

## 22 — 010110 — [— AY — GX GY —]

Y accel + X gyro + Y gyro. Three bits. Compound tilt, no yaw.

**Physics:** Lateral Y force with roll AND pitch — the device rocked in both tilt axes but did NOT yaw. The force was off-center enough to produce compound tilt, but the impact line passed near the Z axis so no Z torque was generated. Krieg & Ebner note: hits that miss the yaw axis are typically "high-center" or "low-center" zones — the force was centered horizontally on the face (no yaw) but significantly off-height (producing both pitch and roll). This is relatively unusual — most real-world side contacts have some horizontal offset producing yaw. The absence of GZ makes this less common than signatures 19 or 21.

**Scenarios:** Centered high hit on Y face — force directly above COM, no horizontal offset, produces pitch + roll but no yaw. Centered low hit — force directly below COM. Impact that is horizontally centered but vertically offset — a "clean above" or "clean below" strike.

**Madgwick:** a_trans on Y. Omega on X and Y. No Z omega. The absence of yaw indicates a horizontally centered impact — the hit was directly above or below the center of the Y face.
**Classification:** crash or bump. Same-axis pairing (Y+GY) means slight a_trans overestimation on Y from lever-arm effect (see signature 18).

**Source:** Krieg & Ebner (2025) — centered high/low impacts miss yaw axis. Brändle et al. (2025) — lever-arm amplification for same-axis pairings.

---

## 23 — 010111 — [— AY — GX GY GZ]

Y accel + all three gyro axes. Four bits. Violent side impact with chaotic tumble.

**Physics:** Hard Y-axis impact with rotation around all three axes — the device was hit hard on the short face and tumbled. In the Haddadin collision severity framework, a 4-bit event maps to "complex impact" — moderate severity minimum. The device not only translated sideways but rotated chaotically — the impact was hard enough and off-center enough to excite every rotational degree of freedom. The Alhaddad et al. (2019) small-robot data: a hard side impact at 2.5 m/s on a 0.55 kg robot produces 15–23g peak — scaling to ~8–12g for our 100g CyberPi. This is severe for the device.

**Scenarios:** Hard side slam on the short face. Device hit by a fast-moving object from the side. Robot drove into a wall at an angle — Y impact + tumble. Something heavy fell onto the device from the side.

**Madgwick:** a_trans on Y (dominant), with X and Z components from tumbling. High omega on all three axes. Large Δorientation. Crash confidence: very high.
**Classification:** crash — near-certain. Four bits with all gyro axes = unambiguous high-energy side impact.

**Source:** Haddadin et al. (2008) — complex impact, 4-bit = moderate-to-severe. Alhaddad et al. (2019) — small robot side impacts 8–23g.

---

## 24 — 011000 — [— AY AZ — — —]

Y + Z accel. No X, no gyro. Diagonal force in the Y-Z plane without rotation. The 2-axis ambiguous signature.

**Physics:** Combined Y and Z force through the center of mass — a diagonal push with zero torque. Physically unusual: requires the force vector to pass exactly through COM to avoid producing any rotation. OR gravity leakage from roll around X — device rolled, gravity shifted Z→Y. Both axes crossed threshold from the same physical rotation but angular velocity stayed below 50 °/s (otherwise GX would fire). The Brändle et al. (2025) analysis: 2-axis accel without gyro is the MOST CONFUSABLE case for Madgwick. Even with adaptive β, if the tilt is fast enough that |a| briefly deviates from 1g, β drops low and rejects accel correction — a_trans shows zero, correctly identifying tilt. If the tilt is slow enough that |a| stays ≈ 1g, β stays high and the filter tracks correctly — a_trans still shows zero. Either way, Madgwick correctly identifies this as tilt if it IS a tilt. The risk window is narrow: fast tilt where |a| happens to stay near 1g (pure rotation, no translation) — the literature says this window is <5% of tilt events.

**Scenarios:** Diagonal push in Y-Z plane through COM (rare — most pushes produce some torque). Fast-onset roll — gravity leaked Z→Y, both crossed threshold from angular jerk, but GX bandwidth didn't catch the brief rotation. The most common real cause: the device was tilted diagonally and placed down, creating a brief diagonal force without sustained rotation.

**Madgwick:** If a_trans ≈ 0 + Δroll > 0 → tilt (gravity leakage). If a_trans > 0 + Δroll ≈ 0 → real diagonal impact (unusual, high confidence if confirmed). If both a_trans AND Δroll are significant → compound event (push during tilt).
**Classification:** bump (real diagonal impact). tilt (gravity leakage — the most common outcome).

**Source:** Brändle et al. (2025) — 2-axis accel without gyro = most confusable case, <5% ambiguity window. Gimpel et al. (2015) — ADL false positives reduced by orientation change verification.

---

## 25 — 011001 — [— AY AZ — — GZ]

Y + Z accel + Z gyro. Three bits. Diagonal corner impact with yaw.

**Physics:** Diagonal force in the Y-Z plane, off-center, producing Z torque. The force had Y and Z components and landed off-center on the Y-Z face — a corner hit where the short face meets the base. Krieg & Ebner (2025): the corner zones with diagonal force + rotation are the highest-confidence classifications because they engage distinct features in both accel AND gyro domains. The Amazon patent US 9,689,887 confirms: corner impacts produce 1.2–1.5× higher peak force than flat impacts at the same velocity because the contact area is smaller. The Z gyro sign identifies which corner: positive GZ = one corner, negative = the other.

**Scenarios:** Corner impact on the Y-Z face — something hit the device where the short face meets the base. Diagonal push near a corner — the off-center force produced yaw. Device struck at an angle on the bottom corner. Drop landing on a corner — Z impact + Y component + yaw.

**Madgwick:** a_trans on Y and Z. Omega on Z. The corner geometry amplifies a_trans by 1.2–1.5× vs. a flat impact at the same force — severity should be up-weighted.
**Classification:** crash (high a_trans, Haddakin L2–L3). bump (moderate, but corner multiplier applies).

**Source:** Amazon US 9,689,887 — corner impacts: 1.2–1.5× force amplification. Krieg & Ebner (2025) — diagonal+rotation = highest confidence.

---

## 26 — 011010 — [— AY AZ — GY —]

Y + Z accel + Y gyro. Three bits. Diagonal Y-Z force with pitch.

**Physics:** Diagonal force in the Y-Z plane, off-center in X (forward/backward from COM), producing pitch (Y rotation). The force landed near the front or back edge of the device on the Y-Z face. Krieg & Ebner (2025): this maps to an "upper" or "lower" impact zone — the pitch sign gives height. Positive GY = nose-down pitch (hit above COM on the front), negative = nose-up pitch (hit below COM on the back). The Valle et al. (2022) oblique impact data: the pitch-to-acceleration ratio (|GY|/|resultant accel|) encodes the impact angle — large ratio = more oblique, small ratio = more perpendicular.

**Scenarios:** Diagonal hit near the front or back edge of the Y-Z face. Drop landing on the front/back edge with a Y component. Impact at an angle on the bottom-front or bottom-back corner.

**Madgwick:** a_trans on Y and Z. Omega on Y. Pitch sign gives impact height. |GY|/|a| ratio gives obliqueness.
**Classification:** crash or bump. Corner geometry: 1.2–1.5× severity multiplier.

**Source:** Krieg & Ebner (2025) — pitch sign = height zone. Valle et al. (2022) — pitch-to-acceleration ratio for impact angle.

---

## 27 — 011011 — [— AY AZ — GY GZ]

Y + Z accel + Y gyro + Z gyro. Four bits. Diagonal corner impact with pitch + yaw.

**Physics:** Diagonal Y-Z force with compound rotation — the device pitched AND yawed from the impact. Four bits puts this in the Haddakin "complex impact" category — moderate severity minimum. The specific pairing (GY+GZ with AY+AZ) means the impact was on a corner of the Y-Z face and produced rotation around both axes. The Amazon patent: two gyro axes active during a corner impact = the corner pivot produced compound rotation as the device tipped. The Krieg & Ebner data: four-bit events have near-certain classification accuracy.

**Scenarios:** Hard corner impact — device struck on a corner of the Y-Z face. Drop landing on a corner with diagonal force. Device tipped off a corner of a table, producing compound rotation on impact.

**Madgwick:** a_trans on Y and Z. Omega on Y and Z. Corner amplification: 1.2–1.5× a_trans. High confidence.
**Classification:** crash — 4 bits with confirmed multi-axis rotation.

**Source:** Amazon US 9,689,887 — 2 gyro axes = corner pivot. Haddadin et al. (2008) — 4-bit = complex impact, moderate-to-severe.

---

## 28 — 011100 — [— AY AZ GX — —]

Y + Z accel + X gyro. Three bits. Diagonal Y-Z force with roll.

**Physics:** Diagonal force in the Y-Z plane, off-center in Y (left/right), producing X rotation (roll). This is the natural rotation axis for a Y-Z force — if the force is in the Y-Z plane and off-center horizontally, it produces roll. Krieg & Ebner (2025): this is the "mid-height side at an angle" zone — the force was in the diagonal plane and landed left or right of COM on the Y-Z face. The GX sign gives which side: positive = hit produced right-roll, negative = left-roll.

**Scenarios:** Diagonal hit left or right of center on the Y-Z face. Drop landing on a side edge with diagonal force. Device struck at an angle near a side corner.

**Madgwick:** a_trans on Y and Z. Omega on X. GX sign gives lateral direction. Corner geometry: 1.2–1.5× severity.
**Classification:** crash or bump. Three bits with orthogonal rotation axis = high confidence.

**Source:** Krieg & Ebner (2025) — mid-height diagonal zone. Amazon US 9,689,887 — corner amplification 1.2–1.5×.

---

## 29 — 011101 — [— AY AZ GX — GZ]

Y + Z accel + X gyro + Z gyro. Four bits. Diagonal corner with roll + yaw.

**Physics:** Diagonal Y-Z force with roll AND yaw. The impact landed on a corner and produced rotation around two axes (X and Z). Krieg & Ebner: four-bit corner events have maximum classification confidence. The GX+GZ pairing means the impact was diagonally off-center in both the lateral and vertical directions. The ratio |GX|/|GZ| reveals whether the impact was more side-offset (GX dominant, roll-heavy) or more corner-offset (GZ dominant, yaw-heavy).

**Scenarios:** Complex corner impact — device struck at a corner of the Y-Z face, producing both roll and yaw. Hard diagonal hit with compound spin.

**Madgwick:** a_trans on Y and Z. Omega on X and Z. High confidence crash.
**Classification:** crash — 4 bits.

**Source:** Krieg & Ebner (2025) — four-bit events: maximum classification confidence.

---

## 30 — 011110 — [— AY AZ GX GY —]

Y + Z accel + X gyro + Y gyro. Four bits. Diagonal corner with roll + pitch, no yaw.

**Physics:** Diagonal Y-Z force with compound tilt — roll + pitch but NO yaw. The Amazon patent identifies this as a "skewed corner" impact — the device contacted a corner but the force line passed near the Z axis, producing pitch and roll moments without Z torque. This is less common than signatures 27 or 29 (which have yaw) — the Amazon data shows <10% of corner impacts lack yaw. The absence of GZ suggests the corner impact was symmetric left-to-right, with the force line passing through the vertical axis.

**Scenarios:** Symmetric corner impact — device landed on a corner but the force was balanced left-to-right, producing roll + pitch without yaw. Impact on the bottom-center edge at a diagonal angle. Unusual corner geometry — verify against other signatures.

**Madgwick:** a_trans on Y and Z. Omega on X and Y. No Z omega. The absence of yaw is the discriminating feature — confirms symmetric corner contact.
**Classification:** crash — 4 bits, but no yaw slightly reduces severity vs. yaw-present corner impacts.

**Source:** Amazon US 9,689,887 — skewed corner, <10% of corner impacts lack yaw.

---

## 31 — 011111 — [— AY AZ GX GY GZ]

Y + Z accel + all three gyro. Five bits. Only AX missing.

**Physics:** Diagonal Y-Z violent impact with chaotic full-axis rotation. The force was entirely in the Y-Z plane (no X accel component) but produced rotation around ALL three axes. Five bits places this in the Haddakin "severe" category — >50% injury probability at human scale. For a 100g CyberPi: the device was struck or dropped on the Y-Z face with enough force to tumble chaotically. The missing AX means the impact was cleanly in the Y-Z plane — no forward/backward component. The Alhaddad et al. (2019) small-robot data: this force level corresponds to a 2.5–5 m/s impact or a >50cm drop onto a hard corner.

**Scenarios:** Violent corner impact on the Y-Z face. Device dropped from height onto a corner — diagonal landing with full tumble. Hard strike on the short face/base corner with chaotic response. The device was thrown or knocked off a surface at speed.

**Madgwick:** a_trans on Y and Z (no X component). High omega on all three axes. Large Δorientation. Freefall flag likely set if it was a drop. Severity is severe — near the upper limit of what the device can experience.
**Classification:** crash — near-certain. Five bits with only one axis missing = unambiguous severe event.

**Source:** Haddadin et al. (2008) — 5-bit = severe, >50% injury probability at human scale. Alhaddad et al. (2019) — 2.5–5 m/s impacts, 15–23g for 0.55 kg.

---

## 32 — 100000 — [AX — — — — —]

Only X accel crossed. No Z, no Y, no gyro. Mirror of signature 16 on the long axis.

**Physics:** Pure lateral force on the X axis (long axis), dead center. OR gravity leakage from pitch around Y — device pitched, gravity shifted Z→X. Same Madgwick discrimination as signature 16: adaptive β (Brändle et al. 2025) resolves real push vs. tilt by gating on |a| deviation from 1g. But X has an additional ambiguity that Y does not: for the mBot2, **X is the direction of travel.** Forward acceleration and braking both produce clean X accel without gyro. The Valle et al. (2022) contact material study found that controlled braking produces a LOW-FREQUENCY, SMOOTH spectral acceleration profile, while a wall collision produces BROADBAND excitation up to 500+ Hz with resonant peaks. At 25 Hz sample rate (Nyquist 12.5 Hz), we cannot do spectral discrimination. This means signature 32 alone CANNOT distinguish self-braking from an external push — both look like a clean X acceleration. Temporal context from telemetry is critical: if the device was moving before the alert (non-zero velocity on X from prior state frames), it is likely self-motion. If stationary, it is an external push. The Valle et al. unsupervised clustering (24 clusters for 6 motion states) separated collision from normal motion — our jerk gate does this separation on-device.

**Scenarios:** Front/back nudge — clean push on the X face. Gravity leakage from pitch — device pitched around Y. mBot2 accelerating/braking — forward motion along X produces X accel. The stationary-before flag from Madgwick discriminates: true = external push, false = likely self-motion.

**Madgwick:** If a_trans on X > 0.3g → bump. If a_trans ≈ 0 + Δpitch > 5° → tilt. If device was in motion before event → consider self-motion context (not an "alert" in the disturbance sense).
**Classification:** bump (real impact). tilt (gravity leakage). If self-motion: suppress alert or flag as "commanded motion."

**Source:** Brändle et al. (2025) — adaptive β for gravity-tilt. Valle et al. (2022) — braking vs. collision: different spectral profiles, 24-cluster motion state separation.

---

## 33 — 100001 — [AX — — — — GZ]

X accel + Z gyro. THE canonical collision signature.

**Physics:** Lateral force on the long face with yaw rotation. This is the most information-dense 2-bit signature. Krieg & Ebner (2025) demonstrated: the GZ SIGN is the single most discriminative feature for side classification — >95% accuracy using gyro-only data. Positive GZ = hit from one side, negative = hit from the other. The GZ MAGNITUDE correlates with off-center distance: larger |GZ| = further from COM = more leverage. The Valle et al. (2022) contact material study: the GZ profile encodes what was struck — hard surfaces (metal, wall) produce broadband gyro excitation; soft surfaces (foam, hand) produce narrower spectra. Three numbers completely characterize the side-swipe geometry: GZ sign = direction, GZ magnitude = off-center distance, AX magnitude = impact force. Additionally, Krieg & Ebner tested varying robot speed during collision (stationary vs. moving) and found classification accuracy drops slightly for moving impacts (~90% vs. ~95% stationary). Our stationary_before flag addresses this.

**Scenarios:** Side-swipe — mBot2 driving, gets clipped, spins. Corner impact on X face — off-center hit, face rotates away. Wall bump while turning — robot is turning (GZ), contacts wall with side (AX). The most common collision signature for a moving robot.

**Madgwick:** a_trans on X, omega on Z. GZ sign gives hit direction. If a_trans > 1.5g AND omega > 5 rad/s → spinning crash (Haddakin L2–L3). Otherwise → bump.
**Classification:** crash (high a_trans + high omega). bump (moderate).

**Source:** Krieg & Ebner (2025) — GZ sign >95% accuracy. Valle et al. (2022) — gyro magnitude from off-center distance, material from spectrum. Haddadin et al. (2008) — severity thresholds.

---

## 34 — 100010 — [AX — — — GY —]

X accel + Y gyro. Lateral force on X with pitch rotation. Mirror of signature 18.

**Physics:** Force on the X face, off-center in Z (above or below COM), producing pitch. The Valle et al. (2022) oblique impact study: the pitch-to-acceleration ratio (|GY|/|AX|) encodes impact angle. Large ratio = grazing impact (force nearly parallel to the face). Ratio near 0 = near-perpendicular hit (force directly into the face). The GY sign gives height: positive GY = hit above COM (nose-down pitch), negative = hit below COM (nose-up pitch). The Krieg & Ebner study: height classification is harder than side classification — accuracy drops for proximal heights. Same-axis pairing (X+GY) means no lever-arm amplification (force and rotation are orthogonal — X force, Y rotation in perpendicular plane), so a_trans is reliable.

**Scenarios:** High push on X face — force above COM, device pitches forward. mBot2 hard acceleration — motors torque chassis, forward accel (X) + pitch (Y) from reaction torque. Low push — force below COM, pitches backward. Grazing impact — force at an angle, more pitch than translation.

**Madgwick:** a_trans on X. Omega on Y. GY sign gives hit height. |GY|/|AX| ratio gives impact obliqueness. Orthogonal axes = no lever-arm amplification, a_trans reliable.
**Classification:** bump (moderate) or crash (high a_trans). If self-motion (mBot2 accelerating) → flag as commanded motion.

**Source:** Valle et al. (2022) — pitch-to-acceleration ratio for impact angle. Krieg & Ebner (2025) — height classification harder than side.

---

## 35 — 100011 — [AX — — — GY GZ]

X accel + Y gyro + Z gyro. Three bits. Off-center, off-height hit on the X face.

**Physics:** Complex side impact — the force landed off-center (GZ = yaw) AND off-height (GY = pitch) on the long face. Krieg & Ebner (2025): three-zone hits with multiple gyro axes have maximum classification confidence (>95%). The GY/GZ ratio reveals impact quadrant on the X face: GZ dominant = more side-offset (near left/right edge), GY dominant = more height-offset (near top/bottom edge), both equal = diagonal corner of the face. The Valle et al. (2022) data confirms: the gyro axis ratio encodes the exact contact point on the face.

**Scenarios:** Diagonal hit on the long face — near a corner, producing pitch + yaw. Robot clipped at an angle while moving — side force + pitch from angled contact. Complex wall collision — the robot hit a wall at an oblique angle, producing both yaw and pitch.

**Madgwick:** a_trans on X. Omega on Y and Z. GY/GZ ratio gives impact quadrant. Higher bit count elevates severity.
**Classification:** crash (high a_trans + multi-axis gyro). bump (moderate). Three-bit events: elevated severity vs. 2-bit.

**Source:** Krieg & Ebner (2025) — multi-axis gyro >95% confidence. Valle et al. (2022) — gyro axis ratio for impact quadrant.

---

## 36 — 100100 — [AX — — GX — —]

X accel + X gyro. Force and rotation around the same axis. Mirror of signature 18 but on X.

**Physics:** Force along X with roll rotation around the SAME X axis. The force was off-center in Y (left/right of COM), producing roll. This is a same-axis pairing — Brändle et al. (2025) specifically warn about this geometry: the IMU lever-arm effect is MAXIMIZED. Tangential acceleration `α × r` from angular acceleration around X produces additional X-axis acceleration at the IMU. The measured AX = real impact force + angular artifact. **a_trans on X is likely OVERESTIMATED.** Severity should be downgraded slightly for this signature compared to orthogonal pairings like 33 (AX+GZ) or 34 (AX+GY). The GX sign gives direction: positive = hit on one side producing right-roll, negative = left-roll.

**Scenarios:** Off-center push on X face, left or right of COM — device pushed forward AND rolls. Corner hit where the X component of force dominates but the impact point was off-center horizontally on the X face. Angled push — force wasn't purely horizontal, producing both X translation and X rotation.

**Madgwick:** a_trans on X (potentially OVERESTIMATED — downgrade severity). Omega on X. GX sign gives lateral direction. Same-axis lever-arm amplification: apply ~0.8× severity multiplier to a_trans.
**Classification:** bump (downgraded severity). crash only if a_trans is still high after 0.8× correction.

**Source:** Brändle et al. (2025) — same-axis force+rotation: maximum lever-arm amplification, a_trans overestimation. Krieg & Ebner (2025) — gyro sign for direction.

---

## 37 — 100101 — [AX — — GX — GZ]

X accel + X gyro + Z gyro. Three bits. Complex hit with same-axis roll + yaw.

**Physics:** X force with roll (same-axis, lever-arm amplified — see signature 36) AND yaw (orthogonal). The GX+GZ pairing means the impact was off-center in both Y (producing roll) and X (producing yaw) on the long face. Krieg & Ebner: three-bit events have maximum confidence, but the same-axis lever-arm amplification on the X component means a_trans should be corrected. GZ sign gives horizontal direction (which side), GX sign gives lateral offset (left/right of COM). The GZ/GX ratio reveals whether the hit was more horizontally off-center (GZ dominant) or laterally off-center (GX dominant).

**Scenarios:** Diagonal hit on the X face — off-center in both directions. Robot clipped at a corner of its long face. Complex wall collision producing both yaw and roll.

**Madgwick:** a_trans on X (lever-arm amplified — apply ~0.8× correction). Omega on X and Z. GZ/GX ratio gives impact quadrant.
**Classification:** crash (high corrected a_trans). bump (moderate). Lever-arm correction applies.

**Source:** Brändle et al. (2025) — lever-arm amplification for same-axis (GX). Krieg & Ebner (2025) — GZ for side discrimination.

---

## 38 — 100110 — [AX — — GX GY —]

X accel + X gyro + Y gyro. Three bits. Compound tilt, no yaw. Mirror of signature 22.

**Physics:** X force with roll + pitch — compound tilt but no yaw. The impact produced rotation in both tilt axes (GX = roll, GY = pitch) but missed the Z axis (no GZ = no yaw). Krieg & Ebner: hits that miss the yaw axis are typically "high-center" or "low-center" zones — the force was centered horizontally on the X face (no yaw) but significantly off-height, producing both pitch and roll. Same-axis lever-arm amplification applies to the X component from GX (see signature 36). The absence of GZ makes this less common than signature 35 — most long-face impacts have some horizontal offset.

**Scenarios:** Centered high hit on X face — force directly above COM, no horizontal offset, pitch + roll. Centered low hit. Impact that is horizontally centered but vertically offset — a "clean above" or "clean below" strike on the long face.

**Madgwick:** a_trans on X (lever-arm amplified on GX component). Omega on X and Y. No Z omega — absence of yaw confirms horizontally centered impact.
**Classification:** crash or bump. Apply 0.8× a_trans correction for same-axis GX component.

**Source:** Krieg & Ebner (2025) — centered high/low impacts miss yaw. Brändle et al. (2025) — lever-arm for same-axis.

---

## 39 — 100111 — [AX — — GX GY GZ]

X accel + all three gyro axes. Four bits. Violent side impact on the long face with chaotic tumble. Mirror of signature 23.

**Physics:** Hard X-axis impact with rotation around ALL three axes — the device was hit hard on the long face and tumbled chaotically. Haddadin: 4-bit = complex impact, moderate-to-severe. The device translated sideways AND rotated around all three axes — the impact was hard enough to excite every degree of freedom. Alhaddad et al. (2019): a hard side impact at 2.5 m/s on a 0.55 kg robot produces 15–23g — scaling to ~8–12g for the 100g CyberPi. The lever-arm amplification from same-axis GX applies (see signature 36) but at these force levels the correction is a small fraction of total a_trans. The multiplicity of gyro axes confirms the event is real and severe regardless of any single-axis measurement error.

**Scenarios:** Hard side slam on the long face. Robot drove into a wall at speed — X impact + full tumble. Something heavy fell onto the device from the side. Device thrown sideways and tumbling.

**Madgwick:** a_trans on X (dominant), with Y and Z components from tumbling. High omega on all three axes. Large Δorientation. Crash confidence: very high.
**Classification:** crash — near-certain. Four bits with all gyro axes = unambiguous severe side impact.

**Source:** Haddadin et al. (2008) — 4-bit = complex impact, moderate-to-severe. Alhaddad et al. (2019) — side impacts 8–23g for small robots.

---

## 40 — 101000 — [AX — AZ — — —]

X + Z accel. No Y, no gyro. Diagonal force in the X-Z plane without rotation. Mirror of signature 24.

**Physics:** Combined X and Z force through COM — diagonal push with zero torque. OR gravity leakage from pitch around Y — device pitched, gravity shifted Z→X. Both axes crossed threshold from the same rotation but angular velocity stayed below 50 °/s (otherwise GY would fire). The Brändle et al. (2025) analysis: 2-axis accel without gyro is the most confusable Madgwick case — same discrimination as signature 24 but in the X-Z plane. The Amazon patent US 9,689,887: diagonal impacts without rotation are classified as "flat angled" landings — the device lands on its face at a slight angle, producing both vertical (Z) and lateral (X) force without rotation. The Valle et al. (2022) data adds: oblique impacts (X+Z) on hard surfaces produce higher peak forces than perpendicular impacts because the contact area is smaller — 1.2–1.5× force amplification. If this is a real impact, it's more severe than the magnitude suggests. If it's a tilt, a_trans ≈ 0 and the event is benign.

**Scenarios:** Diagonal push in X-Z plane through COM. Fast-onset pitch — gravity leaked Z→X, both crossed threshold from angular jerk, but GY bandwidth missed the brief rotation. Flat angled landing — device landed face-down at a slight tilt. Nose-down drop — device fell and hit nose-first. The stationary_before flag distinguishes external force from self-motion.

**Madgwick:** If a_trans ≈ 0 + Δpitch > 0 → tilt. If a_trans > 0 + Δpitch ≈ 0 → real diagonal impact (apply 1.2–1.5× severity for oblique contact). If both → compound event.
**Classification:** bump (real) or tilt (gravity leakage). Corner amplification applies if real.

**Source:** Brändle et al. (2025) — 2-axis accel without gyro = most confusable. Amazon US 9,689,887 — 1.2–1.5× oblique amplification. Valle et al. (2022) — oblique impact forces.

---

## 41 — 101001 — [AX — AZ — — GZ]

X + Z accel + Z gyro. Three bits. Diagonal X-Z force with yaw. Mirror of signature 25.

**Physics:** Diagonal force in the X-Z plane, off-center, producing Z torque. Krieg & Ebner (2025): corner zone impact with diagonal + rotation = maximum classification confidence. The Z gyro sign identifies which side the corner is on. The Amazon patent: corner impacts produce 1.2–1.5× higher peak force than flat impacts. The Valle et al. (2022) data: the gyro magnitude correlates with off-center distance — larger |GZ| = impact was further from COM on the X face.

**Scenarios:** Corner impact on the X-Z face — something hit the device where the long face meets the base. Diagonal clip — off-center diagonal push producing yaw. Nose-down corner landing — device dropped and hit on a front corner.

**Madgwick:** a_trans on X and Z. Omega on Z. GZ sign gives corner side. Corner amplification: 1.2–1.5× severity. High confidence.
**Classification:** crash (high a_trans). bump (moderate, with corner multiplier).

**Source:** Krieg & Ebner (2025) — diagonal+rotation = maximum confidence. Amazon US 9,689,887 — corner amplification.

---

## 42 — 101010 — [AX — AZ — GY —]

X + Z accel + Y gyro. Three bits. Diagonal X-Z force with pitch. Mirror of signature 26.

**Physics:** Diagonal force in X-Z plane, off-center in X (forward/backward from COM), producing pitch. This is the natural rotation axis for an X-Z force — the force is in the X-Z plane, and if off-center horizontally, produces pitch. Krieg & Ebner: this maps to "front-upper" or "front-lower" impact zone. The GY sign gives height: positive = nose-down pitch (hit above COM), negative = nose-up (hit below COM). The Valle et al. (2022) data: the |GY|/|resultant accel| ratio encodes impact angle — large ratio = more oblique (grazing), small ratio = more perpendicular.

**Scenarios:** Nose-down hit — device struck at the front-top corner. Front-edge drop — device fell off a table front-first, landing with X+Z force and pitch. Oblique wall hit — robot drove into a wall at an angle, producing diagonal force + pitch.

**Madgwick:** a_trans on X and Z. Omega on Y. Pitch sign gives impact height. |GY|/|a| ratio for obliqueness. Corner amplification: 1.2–1.5×.
**Classification:** crash or bump. Three bits with orthogonal rotation = high confidence.

**Source:** Krieg & Ebner (2025) — pitch sign for height zone. Valle et al. (2022) — pitch-to-acceleration ratio. Amazon US 9,689,887 — corner amplification.

---

## 43 — 101011 — [AX — AZ — GY GZ]

X + Z accel + Y gyro + Z gyro. Four bits. Diagonal corner with pitch + yaw. Mirror of signature 27.

**Physics:** Diagonal X-Z force with compound rotation — pitch AND yaw. Four bits = Haddakin complex impact, moderate-to-severe. The specific pairing (GY+GZ with AX+AZ) means the impact was on a corner of the X-Z face (long face + base) and produced rotation around two axes. The Amazon patent: two gyro axes during a corner impact = compound corner pivot. The GY/GZ ratio identifies which corner: GY dominant = more front/back offset, GZ dominant = more side offset. Krieg & Ebner: four-bit events have near-certain classification.

**Scenarios:** Hard corner impact on the X-Z face. Device dropped and landed on a front corner — diagonal force + compound rotation. Robot hit a wall corner at an angle — X+Z force + pitch + yaw.

**Madgwick:** a_trans on X and Z. Omega on Y and Z. GY/GZ ratio gives corner identity. Corner amplification: 1.2–1.5×.
**Classification:** crash — 4 bits with confirmed multi-axis rotation.

**Source:** Amazon US 9,689,887 — two gyro = compound corner pivot. Haddadin et al. (2008) — 4-bit = complex impact.

---

## 44 — 101100 — [AX — AZ GX — —]

X + Z accel + X gyro. Three bits. Diagonal X-Z force with roll. Our canonical example.

**Physics:** Diagonal force in X-Z plane, off-center in Y (left/right), producing roll. This is the signature we use throughout the documentation as the canonical collision example. Krieg & Ebner: this is the "mid-height side at an angle" zone — the force was diagonal and landed left or right of COM. The GX sign gives direction. The Amazon patent: diagonal + roll = corner or edge impact with 1.2–1.5× amplification. Orthogonal axes (X+Z force, X rotation = X force is aligned with X rotation axis... wait — actually X force + X gyro is same-axis, lever-arm amplified per Brändle 2025. Apply 0.8× correction to the X component of a_trans). The Z component is clean — no same-axis issue.

**Scenarios:** Side-angle hit — device struck on the long face at a downward angle, producing roll. Drop landing on a side edge — Z impact + X component + roll. Device hit from the side at a downward angle. Impact near a side corner of the long face.

**Madgwick:** a_trans on X (lever-arm amplified from GX — apply 0.8× correction) and Z (clean). Omega on X. GX sign gives lateral direction. Corner amplification: 1.2–1.5×. The net severity is elevated by corner geometry but slightly reduced by same-axis correction — roughly net neutral.
**Classification:** crash or bump. Three bits with mixed lever-arm and corner effects.

**Source:** Brändle et al. (2025) — same-axis lever-arm for X+GX. Amazon US 9,689,887 — corner amplification. Krieg & Ebner (2025) — side-angle zone.

---

## 45 — 101101 — [AX — AZ GX — GZ]

X + Z accel + X gyro + Z gyro. Four bits. Diagonal corner with roll + yaw. Mirror of signature 29.

**Physics:** Diagonal X-Z force with roll AND yaw — the impact landed on a corner and produced rotation around X and Z. Krieg & Ebner: four-bit corner = maximum confidence. The GX+GZ pairing means the impact was off-center in both lateral directions. GZ/GX ratio reveals impact geometry: GZ dominant = more horizontally off-center (near left/right edge), GX dominant = more vertically off-center (near top/bottom of the face). Same-axis lever-arm amplification applies to GX component of a_trans (apply 0.8× correction per Brändle 2025).

**Scenarios:** Complex corner impact — device struck at a corner of the long face. Hard diagonal hit with compound rotation. Drop landing on a side-front corner.

**Madgwick:** a_trans on X (lever-arm corrected on GX component) and Z. Omega on X and Z. High confidence crash.
**Classification:** crash — 4 bits.

**Source:** Krieg & Ebner (2025) — four-bit maximum confidence. Brändle et al. (2025) — lever-arm correction for GX.

---

## 46 — 101110 — [AX — AZ GX GY —]

X + Z accel + X gyro + Y gyro. Four bits. Diagonal corner with roll + pitch, no yaw. Mirror of signature 30.

**Physics:** Diagonal X-Z force with compound tilt — roll + pitch but NO yaw. The Amazon patent: "skewed corner" — device contacted a corner but the force line passed near the Z axis, producing pitch and roll moments without Z torque. <10% of corner impacts lack yaw per Amazon data. Same-axis lever-arm applies to GX component. The absence of GZ distinguishes this from signature 45 — the impact was symmetric left-to-right.

**Scenarios:** Symmetric corner impact — device landed on a corner, force balanced left-to-right, roll + pitch without yaw. Impact on bottom-center edge at diagonal angle. Unusual geometry — verify against other corner signatures.

**Madgwick:** a_trans on X (lever-arm corrected on GX) and Z. Omega on X and Y. No Z omega. Absence of yaw confirms symmetric corner.
**Classification:** crash — 4 bits, but no yaw slightly reduces severity vs. yaw-present corners.

**Source:** Amazon US 9,689,887 — skewed corner, <10% lack yaw. Brändle et al. (2025) — lever-arm correction.

---

## 47 — 101111 — [AX — AZ GX GY GZ]

X + Z accel + all three gyro. Five bits. Only AY missing. Mirror of signature 31.

**Physics:** Diagonal X-Z violent impact with chaotic full-axis rotation. The force was entirely in the X-Z plane (no Y component) but produced rotation around ALL three axes. Five bits = Haddakin severe, >50% injury probability at human scale. For the 100g CyberPi: the device was struck or dropped on the X-Z face with enough force to tumble chaotically. Alhaddad et al. (2019): this corresponds to 2.5–5 m/s impact or >50cm drop onto a hard corner. The missing AY confirms the force was cleanly in the X-Z plane — no side-to-side component. Same-axis lever-arm applies to GX but is negligible at these total force levels. Near-certain crash.

**Scenarios:** Violent corner impact on the X-Z face. Device dropped from height onto a front/side corner — diagonal landing with full tumble. Robot drove into a wall at speed and tumbled. The device was thrown or knocked off a surface.

**Madgwick:** a_trans on X and Z (no Y). High omega all axes. Large Δorientation. Freefall flag likely if dropped. Near-certain crash.
**Classification:** crash — near-certain. Five bits = unambiguous severe event.

**Source:** Haddadin et al. (2008) — 5-bit = severe. Alhaddad et al. (2019) — 2.5–5 m/s impacts, 15–23g for 0.55 kg.

---

## 48 — 110000 — [AX AY — — — —]

X + Y accel. No Z, no gyro. Pure horizontal diagonal force without rotation.

**Physics:** Both lateral axes crossed, no vertical, no rotation. A diagonal push in the horizontal plane through COM — the device was pushed diagonally across the table with zero torque. OR gravity leakage from compound pitch+roll — device tilted diagonally, gravity split Z→X and Z→Y, both crossed 0.40g, but angular velocity on both axes stayed below 50 °/s (otherwise GX or GY would fire). The Brändle et al. (2025) analysis: 2-axis accel without gyro is the most confusable Madgwick case. With adaptive β, the discrimination is reliable: if |a| stays near 1g during the tilt (pure rotation), β stays high and the filter correctly tracks — a_trans ≈ 0. If |a| deviates from 1g (real translation), β drops low — gyro preserves orientation, a_trans shows the real diagonal force. The Valle et al. (2022) data: pure horizontal impacts without vertical component are RARE in practice — most real-world contacts have some vertical component from gravity or table flex. A genuine X+Y-only impact means the force was EXACTLY in the horizontal plane, suggesting either a clean table-height push or the device was sliding and hit a seam.

**Scenarios:** Diagonal push across the table, dead center. Compound tilt — device tilted diagonally, gravity leaked into both X and Y. Sliding stop — device sliding diagonally, hit a seam. The stationary_before flag discriminates: true = external push, false = device was already in motion.

**Madgwick:** If a_trans > 0 → real diagonal impact (rare — most genuine 48s are tilts). If a_trans ≈ 0 + Δorientation > 0 → tilt (gravity leakage — most common). If both → compound event (push during tilt).
**Classification:** bump (real). tilt (gravity leakage — most likely).

**Source:** Brändle et al. (2025) — 2-axis accel without gyro = most confusable. Valle et al. (2022) — pure horizontal impacts rare in practice.

---

## 49 — 110001 — [AX AY — — — GZ]

X + Y accel + Z gyro. Three bits. Horizontal corner impact with yaw.

**Physics:** Diagonal force in the X-Y plane, off-center, producing Z torque. A corner hit in the horizontal plane — the device was struck on a corner, both lateral axes fired, and it spun around Z. Krieg & Ebner (2025): this is the highest-confidence corner signature — diagonal accel + yaw is the most discriminative 2-axis+1-gyro combination for side/corner classification. The GZ sign tells you which corner: positive = one corner, negative = the opposite. The GZ magnitude gives off-center distance. The Amazon patent: corner impacts with one gyro axis are "edge-dominated corners" — the impact was near a corner but the primary rotation was yaw. The Valle et al. (2022) data: the |GZ|/|resultant accel| ratio encodes how corner-like vs. edge-like the impact was — large ratio = pure corner (far from COM), small ratio = near-edge.

**Scenarios:** Corner hit — impact on a corner of the device, producing both lateral forces and Z spin. Very common: device gets hit on a corner and spins. Device sliding diagonally, corner catches on a seam — diagonal force + yaw. Device bumped at a corner while stationary.

**Madgwick:** a_trans on X and Y. Omega on Z. GZ sign gives which corner. Corner amplification: 1.2–1.5×. High confidence.
**Classification:** crash (high a_trans + high omega). bump (moderate, with corner multiplier).

**Source:** Krieg & Ebner (2025) — diagonal+gyro = highest confidence corner. Amazon US 9,689,887 — corner amplification. Valle et al. (2022) — GZ/accel ratio for corner vs. edge.

---

## 50 — 110010 — [AX AY — — GY —]

X + Y accel + Y gyro. Three bits. Horizontal diagonal with pitch.

**Physics:** Diagonal force in X-Y plane, off-center in Z (above/below COM), producing pitch. The force was at an angle in the horizontal plane and off-height, producing Y rotation (pitch). Krieg & Ebner: this maps to an upper or lower corner zone — the pitch sign gives height (positive GY = hit above COM, negative = below). The Valle et al. (2022) data: the |GY|/|resultant accel| ratio encodes vertical offset relative to horizontal force — large ratio = more vertical offset, small ratio = closer to COM height. Orthogonal axis pairing (X+Y force, Y rotation) = no lever-arm amplification, a_trans reliable.

**Scenarios:** Diagonal corner hit with vertical offset — struck at a corner, above or below COM. Device pushed diagonally at an off-height point. Corner impact with pitch but no yaw — the force line produced Y torque but missed the Z axis.

**Madgwick:** a_trans on X and Y. Omega on Y. GY sign gives height. Orthogonal axes = clean a_trans.
**Classification:** crash or bump. Three bits with orthogonal rotation.

**Source:** Krieg & Ebner (2025) — pitch sign for height. Valle et al. (2022) — GY/accel ratio for vertical offset.

---

## 51 — 110011 — [AX AY — — GY GZ]

X + Y accel + Y gyro + Z gyro. Four bits. Horizontal corner with pitch + yaw.

**Physics:** Diagonal horizontal force with compound rotation — pitch AND yaw from a corner impact. Krieg & Ebner: four-bit corner events have near-certain classification. The GY+GZ pairing means the impact was off-center in BOTH Z (height, producing pitch) and X/Y (horizontal, producing yaw) — a "true corner" impact. The GY/GZ ratio reveals corner identity: GY dominant = more height-offset, GZ dominant = more side-offset. Amazon patent: two gyro axes = compound corner pivot with 1.2–1.5× amplification. The Haddakin framework: 4-bit = complex impact, moderate-to-severe.

**Scenarios:** Hard corner impact — device struck at a corner, producing diagonal lateral force + pitch + yaw. Device dropped and landed on a corner. Robot hit a wall corner at an angle.

**Madgwick:** a_trans on X and Y. Omega on Y and Z. High confidence.
**Classification:** crash — 4 bits with confirmed multi-axis corner rotation.

**Source:** Krieg & Ebner (2025) — four-bit maximum confidence. Amazon US 9,689,887 — compound corner pivot. Haddadin et al. (2008) — 4-bit = complex impact.

---

## 52 — 110100 — [AX AY — GX — —]

X + Y accel + X gyro. Three bits. Horizontal diagonal with roll. Mirror of signature 50 on the X rotation axis.

**Physics:** Diagonal force in X-Y plane, off-center in Z (other direction than 50), producing X rotation (roll). Krieg & Ebner: same classification logic as 50 but the rotation axis identifies a different corner pair. GX sign gives lateral direction of vertical offset. Orthogonal pairing (X+Y force, X rotation) = no lever-arm amplification. The |GX|/|resultant accel| ratio encodes vertical offset — same as 50 but with roll instead of pitch.

**Scenarios:** Diagonal corner hit with vertical offset — struck at a corner, producing roll. Device pushed diagonally at an off-height point on the opposite axis pair from 50.

**Madgwick:** a_trans on X and Y. Omega on X. GX sign gives vertical offset direction.
**Classification:** crash or bump.

**Source:** Krieg & Ebner (2025) — gyro axis for corner pair identification.

---

## 53 — 110101 — [AX AY — GX — GZ]

X + Y accel + X gyro + Z gyro. Four bits. Horizontal corner with roll + yaw.

**Physics:** Diagonal horizontal force with roll + yaw. Mirror of 51 with GX instead of GY. Same analysis: off-center in both directions, compound rotation, near-certain classification. The GX/GZ ratio reveals corner identity: GX dominant = more vertically offset (roll-heavy), GZ dominant = more horizontally offset (yaw-heavy).

**Scenarios:** Hard corner impact producing roll + yaw. Device struck at a diagonal corner with compound rotation.

**Madgwick:** a_trans on X and Y. Omega on X and Z. High confidence.
**Classification:** crash — 4 bits.

**Source:** Krieg & Ebner (2025) — four-bit corner maximum confidence.

---

## 54 — 110110 — [AX AY — GX GY —]

X + Y accel + X gyro + Y gyro. Four bits. Horizontal corner with compound tilt, no yaw.

**Physics:** Diagonal horizontal force with roll + pitch but NO yaw. The Amazon patent: "skewed corner" — the impact contacted a corner but the force line passed near the Z axis, producing pitch and roll moments but no Z torque. <10% of corner impacts lack yaw. The absence of GZ means the corner impact was symmetric horizontally — the force was balanced left-to-right. Krieg & Ebner: four-bit events without yaw are correctly classified but with slightly lower confidence than yaw-present corners. The GX/GY ratio reveals the corner pair.

**Scenarios:** Symmetric corner impact — device landed on a corner, force balanced horizontally, roll + pitch without yaw. Impact diagonally on the top or bottom center of a face. Unusual geometry — verify against other corner signatures.

**Madgwick:** a_trans on X and Y. Omega on X and Y. No Z omega. Absence of yaw confirms symmetric horizontal force.
**Classification:** crash — 4 bits, but no yaw slightly reduces severity vs. yaw-present corners.

**Source:** Amazon US 9,689,887 — skewed corner, <10% lack yaw. Krieg & Ebner (2025) — yaw-absent corners: lower confidence.

---

## 55 — 110111 — [AX AY — GX GY GZ]

X + Y accel + all three gyro. Five bits. Only AZ missing. Horizontal crash with full rotation.

**Physics:** Pure horizontal violent impact with chaotic full-axis rotation. The device was slammed horizontally — all lateral axes fired, all gyro axes fired, but NO vertical component (AZ absent). This means the device stayed on the surface — it was a horizontal collision, not a drop. Five bits = Haddakin severe. The Alhaddad et al. (2019) small-robot data: this corresponds to a hard horizontal impact at 2.5–5 m/s, producing 15–23g for a 0.55 kg robot — scaling to 8–12g for our 100g CyberPi. The device was pushed or drove into something at speed. The missing AZ is the key diagnostic: the device never left the surface. This is a collision, not a drop.

**Scenarios:** Robot drove into a wall at speed — horizontal impact + chaotic tumble, stayed on the ground. Device was pushed hard across the table into a barrier. Something heavy slid into the device from the side. Horizontal slam — the device was struck horizontally with enough force to tumble.

**Madgwick:** a_trans on X and Y (no Z component). High omega all axes. Large Δorientation. No freefall (device stayed on surface). Crash confidence: near-certain.
**Classification:** crash — near-certain. Five bits, horizontal collision.

**Source:** Haddadin et al. (2008) — 5-bit = severe. Alhaddad et al. (2019) — horizontal impacts 8–23g.

---

## 56 — 111000 — [AX AY AZ — — —]

All three accel axes. ZERO gyro. THE signature. Ghost crash.

**Physics:** Triaxial force through COM — or fast compound tilt. All three accelerometer axes registered departure from resting, but NO gyro axis crossed 50 °/s. This is the only signature where the raw bits can outright LIE. Two interpretations: (1) genuine triaxial impact where the force vector passed exactly through COM (physically extraordinarily unlikely — requires perfect alignment), or (2) fast compound pitch+roll where gravity rotated through all three axes quickly enough to trigger every accel bit, but the angular velocity on both axes stayed below 50 °/s — the angular JERK fired the gate, not the velocity. The Gimpel et al. (2015) fall detection study: this exact pattern (triaxial accel, no gyro) accounts for 15–30% of false positives in threshold-based systems. Their fix — a multi-phase state machine with freefall detection + impact detection + orientation change verification — reduced false positives to <5%. Our Madgwick adaptive β + freefall flag + Δorientation is structurally identical to their validated pipeline. The ADXL375 noise statistics: the joint probability of all three accel axes false-triggering simultaneously at 8× RMS (0.006% each) is 2.2 × 10⁻⁷ per sample — so this signature is almost certainly a real physical event. The question is whether it's an impact or a tilt. The Haddakin Danger Index: a triaxial acceleration of 1.5–3g maps to L1–L2 ("No Pain" to "No Injury"). Even a genuine impact at these forces is benign for a 100g device. The signature LOOKS alarming (three accel axes!) but the physics says mild.

**Scenarios:** Fast compound tilt — device pitched AND rolled sharply, gravity leaked Z→X and Z→Y, all three accel axes crossed. Genuine triaxial impact through COM — device struck from an arbitrary 3D angle, force vector perfectly aligned with COM (extremely rare). Device tossed and caught — brief triaxial acceleration during the toss, no rotation, caught before impact.

**Madgwick:** THE highest-stakes Madgwick call in the entire 64 signatures. If a_trans ≈ 0 + Δorientation > 0 → tilt (false alarm — ~80% of cases per Gimpel). If a_trans > 0 + Δorientation ≈ 0 → genuine triaxial impact (rare — confirm with high confidence). If both → compound event (crash + tilt). The adaptive β filter is the only defense — fixed β = 0.1 would steer orientation toward the false gravity vector and misclassify.
**Classification:** tilt (most likely — gravity leakage). crash (only if a_trans confirmed > 1.5g with near-zero Δorientation). DO NOT classify without Madgwick confirmation.

**Source:** Gimpel et al. (2015) — 15–30% false positive from ADLs, <5% with multi-phase. ADXL375 noise stats — joint false trigger 2.2 × 10⁻⁷. Haddakin Danger Index — triaxial 1.5–3g = L1–L2 benign.

---

## 57 — 111001 — [AX AY AZ — — GZ]

All three accel + Z gyro. Four bits. Triaxial crash with yaw.

**Physics:** Hard impact from an arbitrary direction, off-center enough to produce Z rotation. All three translational axes fired — the device was hit hard enough to move in every direction. The Z gyro confirms the impact was off-center, producing yaw. The Haddakin framework: 4-bit with triaxial accel = complex impact, moderate-to-severe at minimum. The Paez-Granados & Billard (2022) crash-testing: a 1.5 m/s impact produces ~62g at kg-scale — scaling to ~10–15g for the 100g CyberPi. With adaptive β, the triaxial a_trans is reliable — the gyro bit confirms the force was real and off-center. Not a ghost.

**Scenarios:** Hard multi-directional impact — device struck from an angle, translating in all three axes while yawing. Robot crashed into an obstacle at an angle. Device dropped and landed on a corner — Z impact + lateral components + yaw. Hard hit from an arbitrary direction with spin.

**Madgwick:** a_trans on all three axes. Omega on Z. Gyro confirmation removes ghost ambiguity. Crash confidence: high.
**Classification:** crash — 4 bits with gyro confirmation.

**Source:** Haddadin et al. (2008) — 4-bit = complex impact. Paez-Granados & Billard (2022) — 62g at 1.5 m/s at kg-scale.

---

## 58 — 111010 — [AX AY AZ — GY —]

All three accel + Y gyro. Four bits. Triaxial crash with pitch.

**Physics:** Hard impact with forward/backward rotation. All three accel axes + pitch. Krieg & Ebner: this maps to a front or rear collision with pitch — the robot drove into a wall (pitch forward) or was hit from behind (pitch backward). The pitch sign gives the direction of impact relative to motion.

**Scenarios:** Robot drove into a wall — triaxial deceleration + pitch forward. Hit from behind — triaxial acceleration + pitch backward. Hard frontal collision.

**Madgwick:** a_trans on all three axes. Omega on Y. Pitch sign gives collision direction. High confidence.
**Classification:** crash — 4 bits.

**Source:** Krieg & Ebner (2025) — pitch sign for front/rear. Haddadin et al. (2008) — 4-bit severity.

---

## 59 — 111011 — [AX AY AZ — GY GZ]

All three accel + Y gyro + Z gyro. Five bits. Missing GX. Triaxial crash with pitch + yaw.

**Physics:** Full translational impact + pitch + yaw. No roll. The force produced rotation around Y and Z but missed the X axis — the impact didn't roll the device around its long axis. The Haddakin framework: 5-bit = severe, >50% injury probability at human scale. The missing GX tells you the force was in the Y-Z plane enough to avoid rolling — the device pitched and yawed but didn't rock side-to-side. For a 100g CyberPi: this is a severe crash.

**Scenarios:** Violent multi-angle impact without roll. Robot crashed at an angle producing pitch + yaw but no roll. Device struck from above-front — triaxial force, pitch forward, yaw from off-center contact, no roll.

**Madgwick:** a_trans on all axes. Omega on Y and Z. No X omega. High confidence.
**Classification:** crash — near-certain. Five bits.

**Source:** Haddadin et al. (2008) — 5-bit = severe.

---

## 60 — 111100 — [AX AY AZ GX — —]

All three accel + X gyro. Four bits. Triaxial crash with roll.

**Physics:** Hard impact with side-to-side rotation. Mirror of 58 with roll instead of pitch. The GX sign gives roll direction. Krieg & Ebner: mid-height side impact, triaxial force.

**Scenarios:** Hard side collision — robot struck from the side, triaxial deceleration + roll. Device knocked sideways off a surface — lateral impact + roll + vertical component.

**Madgwick:** a_trans on all axes. Omega on X. High confidence.
**Classification:** crash — 4 bits.

**Source:** Krieg & Ebner (2025) — side collision with roll. Haddadin et al. (2008) — 4-bit severity.

---

## 61 — 111101 — [AX AY AZ GX — GZ]

All three accel + X gyro + Z gyro. Five bits. Missing GY. Triaxial crash with roll + yaw.

**Physics:** Full translational impact + roll + yaw. No pitch. The force produced rotation around X and Z but missed Y — the device rolled and yawed but didn't pitch. Five bits = severe. The missing GY tells you the impact avoided the pitch axis — the force was in the X-Z plane enough to NOT nod the device forward/backward.

**Scenarios:** Side-angle violent crash — roll + yaw without pitch. Robot side-swiped at speed — triaxial force, roll from side contact, yaw from off-center, no pitch. Device struck from the side at an angle.

**Madgwick:** a_trans on all axes. Omega on X and Z. No Y omega. High confidence.
**Classification:** crash — near-certain.

**Source:** Haddadin et al. (2008) — 5-bit = severe.

---

## 62 — 111110 — [AX AY AZ GX GY —]

All three accel + X gyro + Y gyro. Five bits. Missing GZ. Cartwheel crash.

**Physics:** Full translational impact + roll + pitch. No yaw. The spin axis was entirely horizontal — the device cartwheeled. It tumbled in the tilt axes but never spun around Z. Five bits = severe. The Alhaddad et al. (2019) data: a cartwheeling 0.55 kg robot at 5 m/s produces 15–20g peak — scaling to 3–5g for the 100g CyberPi. The missing GZ is the distinctive feature: the device flipped end-over-end without spinning. This is characteristic of an edge-drop where the device was knocked off a surface and tumbled in a single plane. Haddakin: "rolling collision" geometry — device flipped end-over-end. Different context from a wall hit (57–61): cartwheel suggests airborne tumbling before impact.

**Scenarios:** Device knocked off a table — pitched and rolled in freefall, landed without yaw. Edge-drop with rotation — device flipped end-over-end after leaving the surface. Cartwheeling collision — robot hit something at an angle and flipped. Airborne tumble in a single plane.

**Madgwick:** a_trans on all axes. Omega on X and Y. No Z omega. Freefall flag likely set (airborne before impact). The cartwheel geometry distinguishes this from wall-hit crashes — the device was airborne.
**Classification:** crash — near-certain. Cartwheel geometry = airborne event, different from grounded collisions.

**Source:** Alhaddad et al. (2019) — cartwheel impacts 15–20g at 0.55 kg. Haddadin et al. (2008) — rolling collision geometry.

---

## 63 — 111111 — [AX AY AZ GX GY GZ]

All six bits set. Full crash.

**Physics:** Everything crossed threshold. Violent multi-axis impact — the device experienced translational force in all three directions AND rotation around all three axes simultaneously. Three independent literature findings converge: (1) Haddakin Danger Index: 6 bits = Interaction Level L4+, moderate-to-severe at minimum. (2) ADXL375 noise statistics: the joint probability of six independent false triggers at 0.006% each is 4.6 × 10⁻¹⁴ per sample — effectively impossible. This signature is physically real with near-certainty. (3) Amazon drop patent US 9,689,887: all-six-bit events occur in <2% of all drop events but account for >40% of device failures. The orientation at impact is effectively random — no single face is predictable, damage is diffuse. The Paez-Granados & Billard (2022) data: a 1.5 m/s robot collision produces 62g — scaling to 10–15g for the 100g CyberPi. The ONLY scenario where this is NOT a crash: device tossed in the air and caught mid-tumble — gravity rotates through all axes fast enough to trigger every bit, but the device never hits anything. Theoretically possible, vanishingly unlikely in practice. Every occurrence of signature 63 warrants full forensic logging: store the entire 75-sample ring buffer, the full Madgwick per-sample timeseries, and device telemetry for 30 seconds before and after.

**Scenarios:** Hard wall collision at speed — robot drove into a wall, all axes decelerated, chaotic tumble. Drop from height onto a corner — all axes impacted, complex multi-orientation tumble. Device kicked or thrown — large arbitrary force. Rolling down stairs — multiple successive impacts on different faces. Device run over or crushed — extreme multi-axis force.

**Madgwick:** a_trans on all three axes, high magnitude. High omega on all three axes. Large Δorientation. Freefall flag likely set before impact if dropped. Severity: maximum. This signature should produce the highest-confidence crash classification in the system. If Madgwick says a_trans < 0.3g, MADGWICK IS WRONG — not the signature.
**Classification:** crash — maximum confidence. Do not override.

**Source:** Haddadin et al. (2008) — L4+ Danger Index, moderate-to-severe. ADXL375 noise stats — joint false trigger 4.6 × 10⁻¹⁴. Amazon US 9,689,887 — <2% of events, >40% of failures. Paez-Granados & Billard (2022) — 62g at 1.5 m/s.

---

## Summary Table

| Sig | Bits | Physical Regime | Key Ambiguity | Madgwick Resolves |
|---|---|---|---|---|
| 0 | 000000 | Noise | False alarm vs. sub-threshold | a_trans + omega ≈ 0 → noise |
| 1–7 | Gyro only | Rotation | Spin vs. tilt vs. wobble | Δorientation + omega profile |
| 8 | Z accel only | Vertical | Freefall vs. impact vs. lift | Freefall flag + a_trans on Z |
| 16, 32 | X or Y accel only | Lateral | Real push vs. gravity leakage | a_trans ≈ 0 → tilt |
| 24, 40, 48 | Two accel | Diagonal | Real impact vs. fast tilt | a_trans vs. Δorientation |
| 56 | All accel, no gyro | Triaxial | Real crash vs. fast compound tilt | a_trans vs. Δorientation — highest stakes |
| 9–15 | Z accel + gyro(s) | Vertical + spin | Drop with spin vs. corner landing | a_trans magnitude + freefall |
| 17–23 | Y accel + gyro(s) | Lateral Y + spin | Off-center side hit | a_trans + omega pairing |
| 33–39 | X accel + gyro(s) | Lateral X + spin | Off-center side hit | a_trans + omega pairing |
| 41–47 | X+Z accel + gyro(s) | Diagonal impact | Crash vs. bump (severity) | a_trans + omega magnitudes |
| 49–55 | X+Y accel + gyro(s) | Horizontal diagonal | Crash vs. bump (severity) | a_trans + omega magnitudes |
| 57–63 | 3 accel + gyro(s) | Triaxial crash | Always crash | Magnitude only (severity, not regime) |

**Bit count → confidence heuristic:**

| Bits set | Typical regime | Confidence |
|---|---|---|
| 0 | Noise / false alarm | Very low |
| 1 | Single-axis event — tilt, spin, or clean push | Low (high ambiguity) |
| 2 | Two-axis — paired accel+gyro or dual-accel | Medium |
| 3 | Multi-axis — off-center impact | Medium-high |
| 4 | Complex event — crash likely | High |
| 5 | Violent event — almost certainly crash | Very high |
| 6 | Maximum energy — crash | Near-certain |

**The 4 physical regimes that survive Madgwick:**

1. **Impact** — a_trans > 0.3g. Real translational force. Severity from a_trans magnitude.
2. **Tilt** — a_trans ≈ 0, Δorientation > 0. Gravity rotated, no impact. False alarm for the jerk gate.
3. **Freefall** — |a_raw| ≈ 0 for ≥4 samples. Zero-g. Always safety-relevant.
4. **Vibration/oscillation** — high variance, low net a_trans, low net Δorientation. Sustained shaking.
