(function () {
  "use strict";

  function loadImage(src) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        resolve(image);
      };
      image.onerror = function () {
        resolve(null);
      };
      image.src = src;
    });
  }

  function average(data, start, end) {
    var total = 0;
    var count = 0;
    for (var i = start; i < end && i < data.length; i += 1) {
      total += data[i];
      count += 1;
    }
    return count ? total / count / 255 : 0;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function coverRect(image, width, height) {
    var scale = Math.max(width / image.width, height / image.height);
    var drawWidth = image.width * scale;
    var drawHeight = image.height * scale;
    return {
      x: (width - drawWidth) / 2,
      y: (height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight
    };
  }

  function drawCover(ctx, image, width, height) {
    if (!image) {
      return;
    }
    var rect = coverRect(image, width, height);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  }

  function drawSpriteFrame(ctx, image, frameWidth, frameHeight, frameIndex, x, y, width, alpha) {
    if (!image) {
      return;
    }
    var columns = Math.max(1, Math.floor(image.width / frameWidth));
    var frame = Math.abs(frameIndex) % columns;
    var height = width * (frameHeight / frameWidth);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(
      image,
      frame * frameWidth,
      0,
      frameWidth,
      frameHeight,
      x - width / 2,
      y - height / 2,
      width,
      height
    );
    ctx.restore();
  }

  function AudioPartyVisualizer(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.assetBase = (options && options.assetBase) || "./images/audio-party";
    // Optional per-frame callback: receives the analyser bands so an embedding
    // host can mirror the light show (see app.js broadcastFrequency).
    this.onFrequency = (options && options.onFrequency) || null;
    this.audio = null;
    this.audioContext = null;
    this.audioSource = null;
    this.analyser = null;
    this.data = null;
    this.assets = {
      backgrounds: [],
      lights: [],
      stars: [],
      lips: null,
      nymph: null,
      dancer: null
    };
    this.ready = false;
    this.running = false;
    this.energy = 0;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.starOffsets = [0, 160, 320];
    this.bouncer = { x: 0.32, y: 0.42, vx: 0.0018, vy: 0.0012 };
  }

  AudioPartyVisualizer.prototype.load = function () {
    var self = this;
    var bgFiles = ["bg-1.png", "bg-2.png", "bg-3.png", "bg-4.png", "bg-5.png"];
    var lightFiles = [
      "lights1-yellow-1.png",
      "lights1-yellow-2.png",
      "lights1-yellow-3.png",
      "lights1-yellow-4.png",
      "lights1-yellow-3.png",
      "lights1-yellow-2.png",
      "lights1-yellow-1.png",
      "lights2-blue-1.png",
      "lights2-blue-2.png",
      "lights2-blue-3.png",
      "lights2-blue-4.png",
      "lights2-blue-3.png",
      "lights2-blue-2.png",
      "lights2-blue-1.png",
      "lights3-green-1.png",
      "lights3-green-2.png",
      "lights3-green-3.png",
      "lights3-green-4.png",
      "lights3-green-3.png",
      "lights3-green-2.png",
      "lights3-green-1.png",
      "lights4-purple-1.png",
      "lights4-purple-2.png",
      "lights4-purple-3.png",
      "lights4-purple-4.png",
      "lights4-purple-3.png",
      "lights4-purple-2.png",
      "lights4-purple-1.png"
    ];
    var starFiles = ["star-bg-0.png", "star-bg-1.png"];

    return Promise.all([
      Promise.all(bgFiles.map(function (file) { return loadImage(self.assetBase + "/" + file); })),
      Promise.all(lightFiles.map(function (file) { return loadImage(self.assetBase + "/" + file); })),
      Promise.all(starFiles.map(function (file) { return loadImage(self.assetBase + "/" + file); })),
      loadImage(self.assetBase + "/lips.png"),
      loadImage(self.assetBase + "/nymph.png"),
      loadImage(self.assetBase + "/hostage-girl-back.png")
    ]).then(function (results) {
      self.assets.backgrounds = results[0].filter(Boolean);
      self.assets.lights = results[1].filter(Boolean);
      self.assets.stars = results[2].filter(Boolean);
      self.assets.lips = results[3];
      self.assets.nymph = results[4];
      self.assets.dancer = results[5];
      self.ready = true;
      self.start();
    });
  };

  AudioPartyVisualizer.prototype.connect = function (audio) {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return Promise.resolve();
    }

    this.audio = audio;

    if (!this.audioContext) {
      this.audioContext = new AudioContextClass();
      this.audioSource = this.audioContext.createMediaElementSource(audio);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.78;
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.audioSource.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    }

    this.start();
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch(function () {});
    }
    return Promise.resolve();
  };

  AudioPartyVisualizer.prototype.start = function () {
    if (this.running) {
      return;
    }
    this.running = true;
    this.frame();
  };

  AudioPartyVisualizer.prototype.resize = function () {
    var ratio = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
    var height = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));

    if (width === this.lastWidth && height === this.lastHeight) {
      return;
    }

    this.lastWidth = width;
    this.lastHeight = height;
    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  AudioPartyVisualizer.prototype.frame = function () {
    var self = this;
    requestAnimationFrame(function () {
      self.frame();
    });

    this.resize();

    var ctx = this.ctx;
    var width = this.lastWidth;
    var height = this.lastHeight;
    var now = performance.now();

    var bass = 0;
    var mid = 0;
    var high = 0;

    if (this.analyser && this.data && this.audio && !this.audio.paused) {
      this.analyser.getByteFrequencyData(this.data);
      bass = average(this.data, 0, 5);
      mid = average(this.data, 5, 16);
      high = average(this.data, 16, this.data.length);
      this.energy = this.energy * 0.74 + Math.max(bass, mid * 0.86, high * 0.68) * 0.26;
    } else {
      this.energy *= 0.94;
    }

    var pulse = clamp(this.energy, 0, 1);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050508";
    ctx.fillRect(0, 0, width, height);

    this.drawBackground(ctx, width, height, now, bass, pulse);
    this.drawStars(ctx, width, height, now, bass, mid, high);
    var lightFrame = this.drawLights(ctx, width, height, now, mid, pulse);
    this.drawSprites(ctx, width, height, now, bass, mid, high, pulse);
    this.drawEqualizer(ctx, width, height, pulse);
    this.drawVignette(ctx, width, height);

    // Publish the bands to any embedding host. `light` is the mid band — the
    // exact value drawLights() above animates the light rig with. `lightFrame`
    // is the rig frame drawLights just drew: a consumer that re-derived the
    // frame from `light` and its own clock would cycle at the right rate but at
    // an arbitrary phase (performance.now() epochs differ per window), so we
    // hand over the authoritative frame instead.
    if (this.onFrequency) {
      this.onFrequency({
        bass: bass,
        mid: mid,
        high: high,
        energy: pulse,
        light: mid,
        lightFrame: lightFrame,
        lightFrames: this.assets.lights.length,
        playing: !!(this.audio && !this.audio.paused)
      });
    }
  };

  AudioPartyVisualizer.prototype.drawBackground = function (ctx, width, height, now, bass, pulse) {
    var backgrounds = this.assets.backgrounds;
    if (!backgrounds.length) {
      return;
    }

    var frame = Math.floor(now / 820 + bass * 5) % backgrounds.length;
    ctx.save();
    ctx.globalAlpha = 0.74 + pulse * 0.2;
    ctx.filter = "saturate(" + (1.1 + pulse * 1.8) + ") contrast(" + (1.05 + bass * 0.45) + ")";
    drawCover(ctx, backgrounds[frame], width, height);
    ctx.restore();
  };

  AudioPartyVisualizer.prototype.drawStars = function (ctx, width, height, now, bass, mid, high) {
    var stars = this.assets.stars;
    if (!stars.length) {
      return;
    }

    var values = [bass, mid, high];
    for (var i = 0; i < 3; i += 1) {
      var image = stars[i % stars.length];
      var scale = Math.max(width / image.width, height / image.height) * (1 + i * 0.24);
      var drawWidth = image.width * scale;
      var drawHeight = image.height * scale;
      var drawX = (width - drawWidth) / 2;
      var speed = 12 + i * 18 + values[i] * 80;
      var y = ((now / 1000 * speed + this.starOffsets[i]) % drawHeight) - drawHeight;
      var hue = Math.round((values[i] * 240 + i * 82 + now / 90) % 360);

      ctx.save();
      ctx.globalAlpha = 0.2 + values[i] * 0.48;
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "hue-rotate(" + hue + "deg) brightness(" + (0.78 + values[i] * 1.8) + ")";
      while (y < height) {
        ctx.drawImage(image, drawX, y, drawWidth, drawHeight);
        y += drawHeight;
      }
      ctx.restore();
    }
  };

  // Returns the frame index it drew (-1 before the light assets are loaded),
  // so the caller can broadcast the rig's current frame to embedding hosts.
  AudioPartyVisualizer.prototype.drawLights = function (ctx, width, height, now, mid, pulse) {
    var lights = this.assets.lights;
    if (!lights.length) {
      return -1;
    }

    var frame = Math.floor(now / 86 + mid * 18) % lights.length;
    var image = lights[frame];
    var drawWidth = Math.min(width * 0.82, height * 1.08);
    var drawHeight = drawWidth * (image.height / image.width);

    ctx.save();
    ctx.globalAlpha = 0.34 + pulse * 0.54;
    ctx.globalCompositeOperation = "lighter";
    ctx.filter = "saturate(" + (1.5 + pulse * 2.4) + ") blur(" + (pulse * 0.6) + "px)";
    ctx.drawImage(image, (width - drawWidth) / 2, -drawHeight * 0.05, drawWidth, drawHeight);
    ctx.restore();

    return frame;
  };

  AudioPartyVisualizer.prototype.drawSprites = function (ctx, width, height, now, bass, mid, high, pulse) {
    this.bouncer.x += this.bouncer.vx * (1 + high * 2.2);
    this.bouncer.y += this.bouncer.vy * (1 + mid * 1.8);

    if (this.bouncer.x < 0.18 || this.bouncer.x > 0.82) {
      this.bouncer.vx *= -1;
    }
    if (this.bouncer.y < 0.24 || this.bouncer.y > 0.72) {
      this.bouncer.vy *= -1;
    }

    var x = width * this.bouncer.x;
    var y = height * this.bouncer.y;
    var lipsFrame = Math.floor(mid * 5 + now / 180);
    var nymphFrame = Math.floor(bass * 6 + now / 140);
    var dancerFrame = Math.floor(high * 8 + now / 120);

    drawSpriteFrame(ctx, this.assets.lips, 500, 270, lipsFrame, x, y, Math.min(width * 0.5, 520), 0.08 + pulse * 0.18);
    drawSpriteFrame(ctx, this.assets.nymph, 66, 109, nymphFrame, width * 0.52, height * 0.52, Math.min(height * 0.36, 260), 0.08 + bass * 0.22);
    drawSpriteFrame(ctx, this.assets.dancer, 30, 61, dancerFrame, width * 0.48, height * 0.5, Math.min(height * 0.22, 150), 0.06 + high * 0.18);
  };

  AudioPartyVisualizer.prototype.drawEqualizer = function (ctx, width, height, pulse) {
    if (!this.data) {
      return;
    }

    var barCount = Math.min(this.data.length, 32);
    var barWidth = width / barCount;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < barCount; i += 1) {
      var value = this.data[i] / 255;
      var barHeight = (height * 0.08) + value * height * 0.18;
      var hue = (i * 12 + pulse * 160) % 360;
      ctx.fillStyle = "hsla(" + hue + ", 95%, 58%, " + (0.08 + value * 0.34) + ")";
      ctx.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth - 2), barHeight);
    }
    ctx.restore();
  };

  AudioPartyVisualizer.prototype.drawVignette = function (ctx, width, height) {
    var gradient = ctx.createRadialGradient(width / 2, height * 0.42, Math.min(width, height) * 0.2, width / 2, height / 2, Math.max(width, height) * 0.68);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0.66)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
    for (var y = 0; y < height; y += 4) {
      ctx.fillRect(0, y, width, 1);
    }
  };

  window.AudioPartyVisualizer = AudioPartyVisualizer;
})();
