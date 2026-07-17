// js/landing.js — Landing Page Animations & Interactions
// Aeldorado by Solanacy Technologies

(function() {
  "use strict";

  const landing = document.getElementById('page-landing');
  if (!landing) return;

  // ═══════════════════════════════════════════════════════════
  //  STAT COUNTERS (Intersection Observer)
  // ═══════════════════════════════════════════════════════════
  const statSection = document.getElementById('stats');
  if (statSection) {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        statSection.querySelectorAll('.stat-value').forEach(el => {
          const target = parseInt(el.dataset.value || 0);
          const suffix = el.dataset.suffix || '';
          let current = 0;
          const duration = 1500;
          const step = target / (duration / 16);
          
          const counter = setInterval(() => {
            current += step;
            if (current >= target) {
              el.textContent = target.toLocaleString() + suffix;
              clearInterval(counter);
            } else {
              el.textContent = Math.floor(current).toLocaleString() + suffix;
            }
          }, 16);
        });
        observer.unobserve(statSection);
      }
    }, { threshold: 0.1 });
    observer.observe(statSection);
  }

  // ═══════════════════════════════════════════════════════════
  //  CODE TYPING EFFECT
  // ═══════════════════════════════════════════════════════════
  const codeSnippets = {
    curl: `curl -X POST "https://api.aeldorado.solanacy.in/v1/chat/completions" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "agent": "research",
    "messages": [{"role": "user", "content": "Analyze market trends"}]
  }'`,
    python: `import aeldorado

client = aeldorado.Client(api_key="YOUR_API_KEY")

response = client.chat.completions.create(
    agent="research",
    messages=[{"role": "user", "content": "Analyze market trends"}]
)`,
    javascript: `const aeldorado = require('aeldorado');

const client = new aeldorado.Client('YOUR_API_KEY');

async function main() {
  const response = await client.chat.completions.create({
    agent: 'research',
    messages: [{ role: 'user', content: 'Analyze market trends' }]
  });
}`
  };

  const codeEl = document.getElementById('hero-code-content');
  let typeTimer = null;
  
  function typeCode(text, element) {
    if (!element) return;
    if (typeTimer) clearTimeout(typeTimer);
    element.textContent = '';
    element.classList.add('typing');
    let i = 0;
    const next = () => {
      if (i < text.length) {
        element.textContent += text[i++];
        typeTimer = setTimeout(next, 10);
      } else {
        element.classList.remove('typing');
      }
    };
    next();
  }

  // Start typing on load
  if (codeEl) {
    setTimeout(() => typeCode(codeSnippets.curl, codeEl), 900);
  }

  // Tab switching
  landing.querySelectorAll('.code-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      landing.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const lang = tab.dataset.lang;
      if (codeEl && codeSnippets[lang]) typeCode(codeSnippets[lang], codeEl);
    });
  });

  // Copy button
  const copyBtn = document.getElementById('btn-code-copy');
  if (copyBtn && codeEl) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        const originalHtml = copyBtn.innerHTML;
        copyBtn.innerHTML = '<span>Copied!</span>';
        setTimeout(() => { copyBtn.innerHTML = originalHtml; }, 2000);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  HERO PARTICLE BACKGROUND
  // ═══════════════════════════════════════════════════════════
  const pCanvas = document.getElementById('hero-particles-canvas');
  if (pCanvas) {
    const pCtx = pCanvas.getContext('2d');
    let pts = [];
    let pVisible = true;

    function pResize() {
      const parent = pCanvas.parentElement;
      if (!parent) return;
      const r = parent.getBoundingClientRect();
      pCanvas.width = r.width;
      pCanvas.height = r.height;
    }

    function pCreate() {
      const n = Math.min(30, Math.floor((pCanvas.width * pCanvas.height) / 30000));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * pCanvas.width,
        y: Math.random() * pCanvas.height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.5 + 0.5,
        o: Math.random() * 0.25 + 0.08
      }));
    }

    function pDraw() {
      if (!pVisible) return;
      pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > pCanvas.width) a.vx *= -1;
        if (a.y < 0 || a.y > pCanvas.height) a.vy *= -1;
        pCtx.beginPath();
        pCtx.arc(a.x, a.y, a.r, 0, 6.283);
        pCtx.fillStyle = `rgba(138,180,248,${a.o})`;
        pCtx.fill();
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 130) {
            pCtx.beginPath();
            pCtx.moveTo(a.x, a.y);
            pCtx.lineTo(b.x, b.y);
            pCtx.strokeStyle = `rgba(138,180,248,${0.055 * (1 - d / 130)})`;
            pCtx.lineWidth = 0.5;
            pCtx.stroke();
          }
        }
      }
      requestAnimationFrame(pDraw);
    }

    pResize(); pCreate(); pDraw();
    window.addEventListener('resize', () => { pResize(); pCreate(); });
    
    if (window.IntersectionObserver) {
      new IntersectionObserver(([e]) => { pVisible = e.isIntersecting; })
        .observe(pCanvas.parentElement);
    }
  }
})();
