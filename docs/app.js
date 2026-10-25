const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function springParams(response, dampingRatio) {
    const omega = 2 * Math.PI / response;
    return {stiffness: omega * omega, damping: 2 * dampingRatio * omega};
}

const SPRING = springParams(0.32, 0.8);
const STATES = ['clock', 'music', 'claude', 'volume', 'timer'];
const CYCLE_MS = 3200;

function clockText() {
    return new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

const timerEnd = Date.now() + 25 * 60 * 1000;

function timerText() {
    const left = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function render(state) {
    switch (state) {
    case 'music':
        return `<img class="pill-art" src="assets/art.webp" alt=""><span>Low Tide</span><span class="bars"><span></span><span></span><span></span><span></span></span>`;
    case 'claude':
        return `<i class="ph-fill ph-shield pill-icon accent"></i><span>nublet · Bash</span><span class="pill-badge">+1</span>`;
    case 'volume':
        return `<i class="ph-fill ph-speaker-high pill-icon"></i><span>64%</span><span class="pill-level"><span></span></span>`;
    case 'timer':
        return `<i class="ph ph-alarm pill-icon"></i><span data-timer>${timerText()}</span>`;
    default:
        return `<span data-clock>${clockText()}</span>`;
    }
}

function setupPill() {
    const pill = document.querySelector('[data-pill]');
    const content = document.querySelector('[data-pill-content]');
    const chips = document.querySelector('[data-chips]');
    if (!pill || !content || !chips)
        return;

    const spring = {value: 0, target: 0, velocity: 0};
    let state = 'clock';
    let frame = 0;
    let last = 0;
    let cycleId = 0;
    let visible = true;

    const measure = () => content.offsetWidth;

    const apply = () => {
        pill.style.width = `${Math.round(spring.value)}px`;
    };

    const tick = now => {
        const dt = Math.min(0.05, (now - last) / 1000 || 0);
        last = now;
        for (let left = dt; left > 0; left -= 1 / 240) {
            const h = Math.min(1 / 240, left);
            spring.velocity += (SPRING.stiffness * (spring.target - spring.value) - SPRING.damping * spring.velocity) * h;
            spring.value += spring.velocity * h;
        }
        if (Math.abs(spring.target - spring.value) < 0.1 && Math.abs(spring.velocity) < 1) {
            spring.value = spring.target;
            spring.velocity = 0;
            frame = 0;
        } else {
            frame = requestAnimationFrame(tick);
        }
        apply();
    };

    const retarget = () => {
        spring.target = measure();
        if (reduceMotion.matches || !spring.value) {
            spring.value = spring.target;
            apply();
            return;
        }
        if (!frame) {
            last = performance.now();
            frame = requestAnimationFrame(tick);
        }
    };

    const show = next => {
        state = next;
        for (const chip of chips.querySelectorAll('button'))
            chip.setAttribute('aria-pressed', String(chip.dataset.state === next));

        if (reduceMotion.matches || !spring.value) {
            content.innerHTML = render(next);
            retarget();
            return;
        }
        content.classList.add('leaving');
        setTimeout(() => {
            content.innerHTML = render(next);
            content.classList.remove('leaving');
            content.classList.add('entering');
            retarget();
            content.classList.remove('entering');
        }, 90);
    };

    const nextState = () => STATES[(STATES.indexOf(state) + 1) % STATES.length];

    const stopCycle = () => {
        clearInterval(cycleId);
        cycleId = 0;
    };

    const startCycle = () => {
        stopCycle();
        if (!reduceMotion.matches && visible && document.visibilityState === 'visible')
            cycleId = setInterval(() => show(nextState()), CYCLE_MS);
    };

    pill.addEventListener('click', () => {
        show(nextState());
        startCycle();
    });
    chips.addEventListener('click', event => {
        const chip = event.target.closest('button[data-state]');
        if (!chip)
            return;
        show(chip.dataset.state);
        startCycle();
    });

    setInterval(() => {
        const clock = content.querySelector('[data-clock]');
        const timer = content.querySelector('[data-timer]');
        if (clock)
            clock.textContent = clockText();
        if (timer)
            timer.textContent = timerText();
    }, 1000);

    new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible)
            startCycle();
        else
            stopCycle();
    }).observe(pill);
    document.addEventListener('visibilitychange', startCycle);
    reduceMotion.addEventListener('change', startCycle);
    document.fonts?.ready.then(retarget);

    show('clock');
    startCycle();
}

function setupReveal() {
    const items = document.querySelectorAll('.reveal');
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting)
                continue;
            entry.target.classList.add('shown');
            observer.unobserve(entry.target);
        }
    }, {rootMargin: '0px 0px -80px 0px'});
    items.forEach(item => observer.observe(item));
}

function setupCopy() {
    document.addEventListener('click', async event => {
        const button = event.target.closest('[data-copy]');
        if (!button)
            return;
        const text = button.closest('[data-code]').querySelector('code').textContent;
        const label = button.querySelector('span');
        try {
            await navigator.clipboard.writeText(text);
            label.textContent = 'Copied';
        } catch {
            label.textContent = 'Press Ctrl+C';
            const range = document.createRange();
            range.selectNodeContents(button.closest('[data-code]').querySelector('code'));
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        }
        setTimeout(() => {
            label.textContent = 'Copy';
        }, 1600);
    });
}

setupPill();
setupReveal();
setupCopy();
