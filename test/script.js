(function(){
  "use strict";

  // ============================================================
  // MUSIC UTILITIES
  // ============================================================

  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const SCALES = {
    major:         [0,2,4,5,7,9,11,12],
    minor:         [0,2,3,5,7,8,10,12],
    harmonicMinor: [0,2,3,5,7,8,11,12]
  };
  const SCALE_LABELS = { major: "Major", minor: "Minor", harmonicMinor: "Harmonic minor" };

  // Major scale degree -> semitone offset from the root (degree 1..7)
  const MAJOR_DEGREES = [0,2,4,5,7,9,11];

  function midiToFreq(midi){ return 440 * Math.pow(2, (midi - 69) / 12); }
  function freqToMidi(freq){ return 69 + 12 * Math.log2(freq / 440); }
  function midiToNoteName(midi){
    const m = Math.round(midi);
    const name = NOTE_NAMES[((m % 12) + 12) % 12];
    const octave = Math.floor(m / 12) - 1;
    return name + octave;
  }
  function randInt(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // ============================================================
  // AUDIO OUTPUT
  // ============================================================

  let audioCtx = null;
  function ensureAudioCtx(){
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playFrequency(freq, duration = 0.9){
    const ctx = ensureAudioCtx();
    return new Promise(resolve => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;

      const now = ctx.currentTime;
      const attack = 0.02, release = 0.06;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.22, now + attack);
      gain.gain.setValueAtTime(0.22, now + Math.max(attack, duration - release));
      gain.gain.linearRampToValueAtTime(0, now + duration);

      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.03);
      osc.onended = () => resolve();
    });
  }

  async function playSequence(freqs, noteDur = 0.42, gap = 0.05){
    for (const f of freqs){
      await playFrequency(f, noteDur);
      await sleep(gap * 1000);
    }
  }

  // ============================================================
  // PITCH DETECTION (autocorrelation on mic input)
  // ============================================================

  let micStream = null;
  let analyser = null;
  let sourceNode = null;

  async function ensureMic(){
    if (micStream) return;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = ensureAudioCtx();
    sourceNode = ctx.createMediaStreamSource(micStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    sourceNode.connect(analyser);
  }

  function autoCorrelate(buffer, sampleRate){
    const SIZE = buffer.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;

    let r1 = 0, r2 = SIZE - 1;
    const thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++){ if (Math.abs(buffer[i]) < thres){ r1 = i; break; } }
    for (let i = 1; i < SIZE / 2; i++){ if (Math.abs(buffer[SIZE - i]) < thres){ r2 = SIZE - i; break; } }

    const trimmed = buffer.slice(r1, r2);
    const N = trimmed.length;
    if (N < 8) return -1;

    const c = new Array(N).fill(0);
    for (let i = 0; i < N; i++){
      for (let j = 0; j < N - i; j++){
        c[i] += trimmed[j] * trimmed[j + i];
      }
    }

    let d = 0;
    while (d < N - 1 && c[d] > c[d + 1]) d++;

    let maxVal = -1, maxPos = -1;
    for (let i = d; i < N; i++){
      if (c[i] > maxVal){ maxVal = c[i]; maxPos = i; }
    }
    let T0 = maxPos;
    if (T0 <= 0) return -1;

    const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    if (T0 <= 0) return -1;
    return sampleRate / T0;
  }

  // ============================================================
  // MODE SWITCHING (N tabs, thumb geometry computed from the DOM)
  // ============================================================

  const modeSwitch = document.getElementById("modeSwitch");
  const tabs = Array.from(modeSwitch.querySelectorAll("button"));
  const thumb = modeSwitch.querySelector(".thumb");
  const panels = {
    quiz: document.getElementById("quizPanel"),
    trainer: document.getElementById("trainerPanel"),
    builder: document.getElementById("builderPanel")
  };

  function moveThumbTo(btn){
    thumb.style.width = btn.offsetWidth + "px";
    thumb.style.transform = "translateX(" + btn.offsetLeft + "px)";
  }

  function activateTab(name, btn){
    tabs.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    Object.keys(panels).forEach(k => { panels[k].hidden = (k !== name); });
    moveThumbTo(btn);
  }

  tabs.forEach(btn => {
    btn.addEventListener("click", () => activateTab(btn.dataset.mode, btn));
  });

  window.addEventListener("resize", () => {
    const active = tabs.find(b => b.classList.contains("active"));
    if (active) moveThumbTo(active);
  });

  // set initial thumb position once layout is ready
  window.addEventListener("load", () => {
    const active = tabs.find(b => b.classList.contains("active")) || tabs[0];
    moveThumbTo(active);
  });

  // ============================================================
  // QUIZ MODE: IDENTIFY THE SCALE
  // ============================================================

  const quizPlayBtn = document.getElementById("quizPlayBtn");
  const answerBtns = Array.from(document.querySelectorAll(".answers button"));
  const quizScoreEl = document.getElementById("quizScore");
  const quizStreakEl = document.getElementById("quizStreak");
  const quizStatusEl = document.getElementById("quizStatus");

  let quizCorrect = 0, quizTotal = 0, quizStreak = 0;
  let currentQuiz = null;
  let quizAnswered = false;

  function newQuizRound(){
    const root = randInt(55, 65); // G3-F4, comfortable playback range
    const types = Object.keys(SCALES);
    const type = types[randInt(0, types.length - 1)];
    currentQuiz = { root, type };
    quizAnswered = false;
    answerBtns.forEach(b => {
      b.disabled = false;
      b.classList.remove("correct", "wrong");
    });
    quizStatusEl.textContent = "Play the scale when you're ready.";
    quizStatusEl.className = "status";
  }

  quizPlayBtn.addEventListener("click", async () => {
    if (!currentQuiz) newQuizRound();
    quizPlayBtn.disabled = true;
    quizStatusEl.textContent = "Listening...";
    const freqs = SCALES[currentQuiz.type].map(iv => midiToFreq(currentQuiz.root + iv));
    await playSequence(freqs);
    quizPlayBtn.disabled = false;
    if (!quizAnswered) quizStatusEl.textContent = "Which scale was that?";
  });

  answerBtns.forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!currentQuiz || quizAnswered) return;
      quizAnswered = true;
      quizTotal++;
      const isCorrect = btn.dataset.answer === currentQuiz.type;

      answerBtns.forEach(b => b.disabled = true);

      if (isCorrect){
        quizCorrect++;
        quizStreak++;
        btn.classList.add("correct");
        quizStatusEl.textContent = "Correct - " + SCALE_LABELS[currentQuiz.type] + ".";
        quizStatusEl.className = "status good";
      } else {
        quizStreak = 0;
        btn.classList.add("wrong");
        const correctBtn = answerBtns.find(b => b.dataset.answer === currentQuiz.type);
        if (correctBtn) correctBtn.classList.add("correct");
        quizStatusEl.textContent = "Not quite - that was " + SCALE_LABELS[currentQuiz.type] + ".";
        quizStatusEl.className = "status bad";
      }

      quizScoreEl.textContent = "Score: " + quizCorrect + " / " + quizTotal;
      quizStreakEl.textContent = "Streak: " + quizStreak;

      await sleep(1400);
      newQuizRound();
    });
  });

  newQuizRound();

  // ============================================================
  // TRAINER MODE: MATCH THE PITCH
  // ============================================================

  const targetNoteLabel = document.getElementById("targetNoteLabel");
  const playTargetBtn = document.getElementById("playTargetBtn");
  const listenBtn = document.getElementById("listenBtn");
  const nextNoteBtn = document.getElementById("nextNoteBtn");
  const detectedNoteEl = document.getElementById("detectedNote");
  const detectedCentsEl = document.getElementById("detectedCents");
  const trainerStatusEl = document.getElementById("trainerStatus");
  const trainerScoreEl = document.getElementById("trainerScore");
  const needle = document.getElementById("needle");
  const ticksGroup = document.getElementById("ticks");

  const ACCEPTABLE_CENTS = 50;
  const LISTEN_SECONDS = 4;

  let trainerScore = 0, trainerTotal = 0;
  let targetMidi = null;
  let listening = false;

  function drawTicks(){
    const marks = [-50, -25, 0, 25, 50];
    marks.forEach(c => {
      const angle = (c / 50) * 45;
      const rad = (angle - 90) * Math.PI / 180;
      const cx = 110, cy = 118, rOuter = 90, rInner = c === 0 ? 68 : 78;
      const x1 = cx + rOuter * Math.cos(rad);
      const y1 = cy + rOuter * Math.sin(rad);
      const x2 = cx + rInner * Math.cos(rad);
      const y2 = cy + rInner * Math.sin(rad);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("class", "tick" + (c === 0 ? " zero" : ""));
      ticksGroup.appendChild(line);
    });
  }
  drawTicks();

  function setNeedle(cents){
    const clamped = Math.max(-50, Math.min(50, cents));
    const angle = (clamped / 50) * 45;
    needle.setAttribute("transform", "rotate(" + angle + " 110 118)");
  }

  function newTrainerRound(){
    targetMidi = randInt(48, 72); // C3-C5
    targetNoteLabel.textContent = midiToNoteName(targetMidi);
    detectedNoteEl.textContent = "-";
    detectedCentsEl.textContent = "sing when ready";
    detectedCentsEl.className = "cents";
    setNeedle(0);
    trainerStatusEl.textContent = "Play the target, then start listening and sing it back.";
    trainerStatusEl.className = "status";
    nextNoteBtn.hidden = true;
    listenBtn.disabled = false;
  }

  playTargetBtn.addEventListener("click", async () => {
    if (targetMidi === null) newTrainerRound();
    playTargetBtn.disabled = true;
    await playFrequency(midiToFreq(targetMidi), 1.3);
    playTargetBtn.disabled = false;
  });

  listenBtn.addEventListener("click", async () => {
    if (listening) return;
    if (targetMidi === null) newTrainerRound();

    try {
      await ensureMic();
    } catch (err) {
      trainerStatusEl.textContent = "Microphone access was blocked or unavailable. Allow mic access in your browser to use this mode.";
      trainerStatusEl.className = "status bad";
      return;
    }

    listening = true;
    listenBtn.textContent = "\u25CF Listening...";
    listenBtn.classList.add("listening");
    playTargetBtn.disabled = true;
    trainerStatusEl.textContent = "Sing the target note now...";
    trainerStatusEl.className = "status";

    const sampleRate = audioCtx.sampleRate;
    const buffer = new Float32Array(analyser.fftSize);
    const collected = [];
    const startTime = performance.now();

    function frame(){
      if (!listening) return;
      analyser.getFloatTimeDomainData(buffer);
      const freq = autoCorrelate(buffer, sampleRate);

      if (freq > 70 && freq < 1000){
        collected.push(freq);
        const midiFloat = freqToMidi(freq);
        const cents = (midiFloat - targetMidi) * 100;
        detectedNoteEl.textContent = midiToNoteName(midiFloat);
        const c = cents.toFixed(0);
        detectedCentsEl.textContent = (cents >= 0 ? "+" : "") + c + "\u00A2 vs target";
        detectedCentsEl.className = "cents " + (Math.abs(cents) <= ACCEPTABLE_CENTS ? "good" : "bad");
        setNeedle(cents);
      }

      if (performance.now() - startTime < LISTEN_SECONDS * 1000){
        requestAnimationFrame(frame);
      } else {
        finishListening(collected);
      }
    }
    requestAnimationFrame(frame);
  });

  function finishListening(collected){
    listening = false;
    listenBtn.textContent = "\u25CF Start listening";
    listenBtn.classList.remove("listening");
    playTargetBtn.disabled = false;
    listenBtn.disabled = true;
    nextNoteBtn.hidden = false;

    if (collected.length === 0){
      trainerStatusEl.textContent = "No steady pitch detected. Try singing a sustained, clear note.";
      trainerStatusEl.className = "status bad";
      return;
    }

    const midiValues = collected.map(freqToMidi);
    const rounded = midiValues.map(v => Math.round(v));
    const counts = {};
    rounded.forEach(v => counts[v] = (counts[v] || 0) + 1);
    let modeMidi = null, modeCount = -1;
    Object.keys(counts).forEach(k => {
      if (counts[k] > modeCount){ modeCount = counts[k]; modeMidi = parseInt(k, 10); }
    });

    const matching = collected.filter((f, i) => rounded[i] === modeMidi).sort((a, b) => a - b);
    const medianFreq = matching[Math.floor(matching.length / 2)];
    const finalCents = (freqToMidi(medianFreq) - targetMidi) * 100;

    detectedNoteEl.textContent = midiToNoteName(freqToMidi(medianFreq));
    detectedCentsEl.textContent = (finalCents >= 0 ? "+" : "") + finalCents.toFixed(0) + "\u00A2 vs target";
    detectedCentsEl.className = "cents " + (Math.abs(finalCents) <= ACCEPTABLE_CENTS ? "good" : "bad");
    setNeedle(finalCents);

    trainerTotal++;
    if (Math.abs(finalCents) <= ACCEPTABLE_CENTS){
      trainerScore++;
      trainerStatusEl.textContent = "Matched. That was within " + ACCEPTABLE_CENTS + " cents.";
      trainerStatusEl.className = "status good";
    } else {
      trainerStatusEl.textContent = finalCents > 0 ? "Close - you sang a touch sharp." : "Close - you sang a touch flat.";
      trainerStatusEl.className = "status bad";
    }
    trainerScoreEl.textContent = "Score: " + trainerScore + " / " + trainerTotal;
  }

  nextNoteBtn.addEventListener("click", newTrainerRound);
  newTrainerRound();

  // ============================================================
  // BUILD-A-PHRASE MODE: root note + major-scale degree sequence
  // e.g. root "C" + sequence "135" plays C, then E, then G.
  // ============================================================

  const rootSelectEl = document.getElementById("rootSelect");
  const rootChipEl = document.getElementById("rootChip");
  const sequenceTextEl = document.getElementById("sequenceText");
  const numpadEl = document.getElementById("numpad");
  const builderPlayBtn = document.getElementById("builderPlayBtn");
  const builderStatusEl = document.getElementById("builderStatus");
  const clearBtn = document.getElementById("clearSeqBtn");
  const backBtn = document.getElementById("backspaceBtn");

  const BASE_OCTAVE_MIDI = 60; // C4, root note buttons map onto this octave
  const MAX_SEQUENCE_LENGTH = 16;

  let selectedRootPC = 0; // pitch class, 0 = C
  let sequence = [];

  // build root note buttons (12 pitch classes, sharps included)
  NOTE_NAMES.forEach((name, pc) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = name;
    btn.dataset.pc = pc;
    if (pc === 0) btn.classList.add("active");
    btn.addEventListener("click", () => {
      selectedRootPC = pc;
      rootChipEl.textContent = name;
      Array.from(rootSelectEl.children).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    rootSelectEl.appendChild(btn);
  });

  // build number pad 1-9
  for (let d = 1; d <= 9; d++){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(d);
    btn.addEventListener("click", () => {
      if (sequence.length >= MAX_SEQUENCE_LENGTH) return;
      sequence.push(d);
      renderSequence();
    });
    numpadEl.appendChild(btn);
  }

  function renderSequence(){
    if (sequence.length === 0){
      sequenceTextEl.textContent = "Tap degrees to build a sequence";
      sequenceTextEl.classList.add("placeholder");
    } else {
      sequenceTextEl.textContent = sequence.join("");
      sequenceTextEl.classList.remove("placeholder");
    }
  }
  renderSequence();

  clearBtn.addEventListener("click", () => {
    sequence = [];
    renderSequence();
  });

  backBtn.addEventListener("click", () => {
    sequence.pop();
    renderSequence();
  });

  function degreeToMidi(digit){
    // digit is 1-9+; wraps into extra octaves past scale degree 7
    const zeroIndexed = digit - 1;
    const degreeIndex = zeroIndexed % 7;
    const octaveShift = Math.floor(zeroIndexed / 7);
    return BASE_OCTAVE_MIDI + selectedRootPC + MAJOR_DEGREES[degreeIndex] + 12 * octaveShift;
  }

  builderPlayBtn.addEventListener("click", async () => {
    if (sequence.length === 0){
      builderStatusEl.textContent = "Build a sequence first, then press play.";
      builderStatusEl.className = "status bad";
      return;
    }
    builderPlayBtn.disabled = true;
    builderStatusEl.textContent = "Playing " + rootChipEl.textContent + ", " + sequence.join("") + "...";
    builderStatusEl.className = "status";

    const freqs = sequence.map(d => midiToFreq(degreeToMidi(d)));
    await playSequence(freqs, 0.45, 0.06);

    builderPlayBtn.disabled = false;
    builderStatusEl.textContent = "Done. Adjust the root or sequence and play again.";
    builderStatusEl.className = "status";
  });

})();
