// SoundControls.js
// Background music + click sound controls for Mars Scout.

let initialized = false;

export function initSound({
  musicUrl = '/audio/music.mp3',
  clickUrl = '/audio/click.wav',
} = {}) {
  if (initialized) return;
  initialized = true;

  // --------------------------------------------------
  // CSS
  // --------------------------------------------------
  const style = document.createElement('style');

  style.textContent = `
    .mars-sound-controls {
      position: fixed;
      left: 24px;
      bottom: 24px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-family: Arial, sans-serif;
      color: #f4eadb;
    }

    .mars-sound-group {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(20, 12, 8, .72);
      backdrop-filter: blur(8px);
      border-radius: 8px;
    }

    .mars-sound-button {
      min-width: 38px;
      height: 32px;
      border: 1px solid rgba(255,255,255,.25);
      border-radius: 5px;
      background: rgba(255,255,255,.08);
      color: #fff;
      cursor: pointer;
      font-size: 15px;
    }

    .mars-sound-button:hover {
      background: rgba(255,255,255,.18);
    }

    .mars-sound-button.on {
      background: rgba(190, 110, 55, .65);
    }

    .mars-sound-label {
      min-width: 92px;
      font-size: 11px;
      letter-spacing: .04em;
    }

    .mars-sound-slider {
      width: 90px;
      accent-color: #d88952;
      cursor: pointer;
    }

    @media (max-width: 700px) {
      .mars-sound-controls {
        left: 12px;
        bottom: 12px;
      }

      .mars-sound-slider {
        width: 70px;
      }
    }
  `;

  document.head.appendChild(style);

  // --------------------------------------------------
  // HTML
  // --------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'mars-sound-controls';

  controls.innerHTML = `
    <div class="mars-sound-group">
      <button
        id="marsMusicButton"
        class="mars-sound-button"
        type="button"
        aria-label="Turn music on"
      >♫</button>

      <span id="marsMusicLabel" class="mars-sound-label">
        Music off
      </span>

      <input
        id="marsMusicVolume"
        class="mars-sound-slider"
        type="range"
        min="0"
        max="100"
        value="45"
      />
    </div>

    <div class="mars-sound-group">
      <button
        id="marsClickButton"
        class="mars-sound-button on"
        type="button"
        aria-label="Turn click sound off"
      >●</button>

      <span id="marsClickLabel" class="mars-sound-label">
        Click sound on
      </span>

      <input
        id="marsClickVolume"
        class="mars-sound-slider"
        type="range"
        min="0"
        max="100"
        value="55"
      />
    </div>
  `;

  document.body.appendChild(controls);

  // --------------------------------------------------
  // Audio
  // --------------------------------------------------
  const music = new Audio(musicUrl);
  music.loop = true;
  music.preload = 'auto';

  const clickSound = new Audio(clickUrl);
  clickSound.preload = 'auto';

  let musicOn = false;
  let clickOn = true;

  const musicButton = document.getElementById('marsMusicButton');
  const musicLabel = document.getElementById('marsMusicLabel');
  const musicVolume = document.getElementById('marsMusicVolume');

  const clickButton = document.getElementById('marsClickButton');
  const clickLabel = document.getElementById('marsClickLabel');
  const clickVolume = document.getElementById('marsClickVolume');

  function volume(value) {
    return Number(value) / 100;
  }

  music.volume = volume(musicVolume.value);
  clickSound.volume = volume(clickVolume.value);

  // --------------------------------------------------
  // Music
  // --------------------------------------------------
  function updateMusicUI() {
    musicButton.classList.toggle('on', musicOn);

    musicLabel.textContent = musicOn
      ? 'Music on'
      : 'Music off';

    musicButton.setAttribute(
      'aria-label',
      musicOn ? 'Turn music off' : 'Turn music on'
    );
  }

  async function toggleMusic() {
    if (musicOn) {
      music.pause();
      musicOn = false;
      updateMusicUI();
      return;
    }

    try {
      await music.play();
      musicOn = true;
      updateMusicUI();
    } catch (error) {
      console.warn('Mars Scout music could not start:', error);
    }
  }

  musicButton.addEventListener('click', toggleMusic);

  musicVolume.addEventListener('input', () => {
    music.volume = volume(musicVolume.value);
  });

  // --------------------------------------------------
  // Click sound
  // --------------------------------------------------
  function updateClickUI() {
    clickButton.classList.toggle('on', clickOn);

    clickLabel.textContent = clickOn
      ? 'Click sound on'
      : 'Click sound off';

    clickButton.setAttribute(
      'aria-label',
      clickOn
        ? 'Turn click sound off'
        : 'Turn click sound on'
    );
  }

  clickButton.addEventListener('click', () => {
    clickOn = !clickOn;
    updateClickUI();
  });

  clickVolume.addEventListener('input', () => {
    clickSound.volume = volume(clickVolume.value);
  });

  // --------------------------------------------------
  // Play click sound on UI interaction
  // --------------------------------------------------
  document.addEventListener(
    'click',
    (event) => {
      if (!clickOn) return;

      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (
          target.tagName === 'BUTTON' ||
          target.closest('button') ||
          target.closest('[role="button"]')
        )
      ) {
        if (
          target === clickButton ||
          target.closest('#marsClickButton')
        ) {
          return;
        }

        clickSound.currentTime = 0;

        clickSound.play().catch(() => {
          // Browser may block sound until user interaction.
        });
      }
    },
    true
  );

  updateMusicUI();
  updateClickUI();

  // --------------------------------------------------
  // Public controls
  // --------------------------------------------------
  return {
    toggleMusic,
    playClick() {
      if (!clickOn) return;

      clickSound.currentTime = 0;
      clickSound.play().catch(() => {});
    },

    musicOn() {
      return musicOn;
    },

    clickOn() {
      return clickOn;
    },
  };
}