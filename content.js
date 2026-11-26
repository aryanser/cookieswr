function logToCmd(step, detail) {
  try {
    chrome.runtime.sendMessage({ type: 'CMD_LOG', step, detail });
  } catch (e) {}
}

(function () {
    'use strict';

    const baseCfg = typeof JKT48_DEFAULT_CONFIG !== 'undefined' ? JKT48_DEFAULT_CONFIG : {};

    const CONFIG = {
        productKeyword: baseCfg.productKeyword || '',
        queue: Array.isArray(baseCfg.queue) ? baseCfg.queue : [],
        paymentMethod: baseCfg.paymentMethod || 'JKT48 Point',
        autoConfirmPurchase: true,
        catalogUrl: 'https://jkt48.com/what-are-exclusive/all?category=',
        soldOutTimeout: 1000,
        loopDelay: 150,
        interval: 100,
        debug: true
    };

    const STORAGE_KEY = 'jkt48_queue_index';
    const DETECTED_URL_KEY = 'jkt48_detected_purchase_url';

    let currentIndex = Number(sessionStorage.getItem(STORAGE_KEY) || 0);
    let configLoaded = false;

    // Dengarkan jika pengguna mengubah daftar member di popup secara real-time
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            if (changes.jkt48Queue?.newValue) {
                CONFIG.queue = changes.jkt48Queue.newValue;
                sessionStorage.removeItem(STORAGE_KEY);
                currentIndex = 0;
            }
            if (changes.jkt48Payment?.newValue) {
                CONFIG.paymentMethod = changes.jkt48Payment.newValue;
            }
        }
    });

    const getStartUrl = () => sessionStorage.getItem(DETECTED_URL_KEY) || CONFIG.catalogUrl;
    const getCurrentTarget = () => CONFIG.queue[currentIndex] || null;
    const log = (...args) => { if (CONFIG.debug) console.log('[JKT48 AUTO]', ...args); };
    const normalize = v => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const STATE = {
        buyClicked: false,
        dateSelected: false,
        sessionSelected: false,
        memberSelected: false,
        submitClicked: false,
        paymentSelected: false,
        termsAccepted: false,
        confirmClicked: false,
        successHandled: false,
        completed: false,
        busy: false,
        unavailableSince: null,
        lastBannerClickAt: 0,
        loggedSteps: {}
    };

    // Helper agar setiap langkah hanya melapor 1x ke CMD
    function notifyCmdOnce(key, step, detail) {
        if (STATE.loggedSteps[key]) return;
        STATE.loggedSteps[key] = true;
        logToCmd(step, detail);
    }

    const visible = el => {
        if (!el || !el.isConnected) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0;
    };

    const enabled = el =>
        el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';

    function clickElement(el) {
        if (!el || !visible(el) || !enabled(el)) return false;

        const rect = el.getBoundingClientRect();
        const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
        };

        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        el.click();
        return true;
    }

    function setStatus(message, bgColor = '#171717') {
        let panel = document.getElementById('jkt48-auto-status');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'jkt48-auto-status';
            Object.assign(panel.style, {
                position: 'fixed',
                bottom: '15px',
                right: '15px',
                zIndex: '999999',
                color: '#fff',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                fontFamily: 'Arial, sans-serif',
                boxShadow: '0 3px 15px #0005',
                maxWidth: '340px',
                pointerEvents: 'none'
            });
            document.body.appendChild(panel);
        }

        panel.style.background = bgColor;
        const total = CONFIG.queue.length;
        const stepLabel = currentIndex < total ? `${currentIndex + 1}/${total}` : `${total}/${total}`;
        const target = getCurrentTarget();
        const memberTag = target ? ` (${target.member})` : '';
        panel.textContent = `[${stepLabel}]${memberTag} ${message}`;
        log(`[${stepLabel}]${memberTag}`, message);
    }

    function isInWaitingRoom() {
        const bodyText = normalize(document.body?.innerText || '');
        const titleText = normalize(document.title || '');
        return titleText.includes('waiting room') ||
            bodyText.includes('anda sekarang berada dalam antrian');
    }

    function advanceQueue(reason = 'SUKSES', color = '#15803d') {
        if (STATE.successHandled) return;
        STATE.successHandled = true;

        const finishedTarget = getCurrentTarget();
        const targetInfo = finishedTarget
            ? `${finishedTarget.member} | ${finishedTarget.session} (${finishedTarget.quantity}x)`
            : window.location.href;

        // Kirim laporan ke CMD sesuai hasil akhir (SUKSES vs SOLD OUT/SKIP)
        if (reason === 'SUKSES') {
            logToCmd('SUCCESS', `Tiket berhasil dibeli! -> ${targetInfo}`);
        } else {
            logToCmd('SKIP', `${reason} -> ${targetInfo}`);
        }

        currentIndex += 1;
        sessionStorage.setItem(STORAGE_KEY, String(currentIndex));

        if (currentIndex < CONFIG.queue.length) {
            const nextTarget = getCurrentTarget();
            setStatus(`${reason} (${finishedTarget?.member})! Lanjut ke ${nextTarget.member}...`, color);
            setTimeout(() => {
                window.location.href = getStartUrl();
            }, CONFIG.loopDelay);
        } else {
            STATE.completed = true;
            sessionStorage.removeItem(STORAGE_KEY);
            sessionStorage.removeItem(DETECTED_URL_KEY);
            setStatus(`SEMUA SELESAI! Total ${CONFIG.queue.length} antrean diproses.`, '#15803d');
        }
    }

    function captureNewEventUrl() {
        if (location.pathname.includes('/purchase/exclusive') && location.search.includes('code=')) {
            const currentFullUrl = location.origin + location.pathname + location.search;
            if (sessionStorage.getItem(DETECTED_URL_KEY) !== currentFullUrl) {
                sessionStorage.setItem(DETECTED_URL_KEY, currentFullUrl);
                log('Code event baru terdeteksi & disimpan:', currentFullUrl);
            }
        }
    }

    // 1. Auto-klik kartu produk PERTAMA
    function selectFirstPhotobook() {
        if (!location.pathname.includes('/what-are-exclusive/all')) return false;
        if (Date.now() - STATE.lastBannerClickAt < 800) return true;

        if (normalize(document.body.innerText).includes('loading 2-shot')) {
            STATE.catalogReadyAt = null;
            return false;
        }

        if (!STATE.catalogReadyAt) {
            STATE.catalogReadyAt = Date.now();
            return false;
        }
        if (Date.now() - STATE.catalogReadyAt < 100) return false;

        const isMobileLayout = window.innerWidth < 768;
        const minLeft = isMobileLayout ? 5 : 250;
        const minTop = isMobileLayout ? 120 : 100;

        const posters = [...document.querySelectorAll('img')].filter(img => {
            if (!visible(img) || !img.complete || img.naturalWidth === 0) return false;
            const rect = img.getBoundingClientRect();
            return rect.left >= minLeft &&
                rect.top >= minTop &&
                rect.width >= 80 &&
                rect.height >= 80;
        });

        if (posters.length === 0) return false;

        posters.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            if (Math.abs(ra.top - rb.top) > 40) return ra.top - rb.top;
            return ra.left - rb.left;
        });

        const kw = normalize(CONFIG.productKeyword);
        let targetImg = posters[0];

        if (kw) {
            const matched = posters.find(img => {
                const container = img.closest('div')?.parentElement || img.parentElement;
                const txt = normalize(container?.innerText);
                const alt = normalize(img.getAttribute('alt'));
                return txt.includes(kw) || alt.includes(kw);
            });
            if (matched) targetImg = matched;
        }

        const wrapper1 = targetImg.parentElement;
        const wrapper2 = wrapper1?.parentElement;

        clickElement(targetImg);
        if (wrapper1) clickElement(wrapper1);
        if (wrapper2) clickElement(wrapper2);

        STATE.lastBannerClickAt = Date.now();
        STATE.catalogReadyAt = null;
        setStatus('Membuka banner pertama...');
        notifyCmdOnce('event_banner', 'PILIH EVENT', `Klik banner event (${CONFIG.productKeyword || 'Banner #1'})`);
        return true;
    }

    // 2. Klik tombol Beli 2-Shot di halaman detail produk
    function clickBuyButton() {
        if (STATE.buyClicked) return false;

        const button = [...document.querySelectorAll('button')].find(btn =>
            visible(btn) &&
            normalize(btn.innerText).includes('beli 2-shot') &&
            enabled(btn)
        );

        if (!button) return false;

        STATE.buyClicked = true;
        setStatus('Membuka pilihan 2-Shot...');
        notifyCmdOnce('buy_btn', 'PILIH EVENT', 'Klik tombol Beli 2-Shot');
        return clickElement(button);
    }

    // 3. Pilih Tanggal
    function selectDate(target) {
        if (STATE.dateSelected) return false;

        const dateButton = [...document.querySelectorAll('button[role="combobox"]')].find(visible);
        if (!dateButton) return false;

        if (normalize(dateButton.innerText).includes(normalize(target.date))) {
            STATE.dateSelected = true;
            setStatus('Tanggal dipilih: ' + target.date);
            return true;
        }

        const optionVisible = [...document.querySelectorAll('button[id^="btn-option-"]')].some(visible);
        if (!optionVisible) {
            clickElement(dateButton);
        }

        return false;
    }

    function chooseDateOption(target) {
        if (STATE.dateSelected) return false;

        const option = [...document.querySelectorAll('button[id^="btn-option-"]')]
            .find(btn =>
                visible(btn) &&
                normalize(btn.innerText || btn.textContent).includes(normalize(target.date))
            ) || document.querySelector('#btn-option-0');

        if (!option || !visible(option) || !enabled(option)) return false;

        clickElement(option);
        return false;
    }

    // 4. Pilih Sesi
    function selectSession(target) {
        if (STATE.sessionSelected) return false;

        const session = [...document.querySelectorAll('div.cursor-pointer')].find(el =>
            visible(el) &&
            normalize(el.innerText || el.textContent) === normalize(target.session)
        );

        if (!session) {
            const dateBox = [...document.querySelectorAll('button[role="combobox"]')].find(visible);
            if (dateBox) {
                if (!STATE.unavailableSince) STATE.unavailableSince = Date.now();
                const waited = Date.now() - STATE.unavailableSince;
                const sisa = Math.max(0, ((CONFIG.soldOutTimeout - waited) / 1000)).toFixed(1);

                setStatus(`${target.session} tidak tersedia (${sisa}d)...`, '#b45309');

                if (waited >= CONFIG.soldOutTimeout) {
                    advanceQueue('SESI TIDAK TERSEDIA', '#b91c1c');
                }
            }
            return false;
        }

        STATE.unavailableSince = null;

        if (clickElement(session)) {
            STATE.sessionSelected = true;
            setStatus('Sesi dipilih: ' + target.session);
            return true;
        }

        return false;
    }

    // 5. Pilih Member & Jumlah
    function selectMember(target) {
        if (STATE.memberSelected) return false;

        const hasMemberList = [...document.querySelectorAll('label')].some(l =>
            visible(l) && l.querySelector('div.font-bold')
        );
        if (!hasMemberList) return false;

        const memberLabel = [...document.querySelectorAll('label')].find(label => {
            if (!visible(label)) return false;
            const nameEl = label.querySelector('div.font-bold');
            return nameEl && normalize(nameEl.textContent) === normalize(target.member);
        });

        const input = memberLabel?.querySelector('input[data-slot="input"], input[role="spinbutton"]');
        const plus = memberLabel?.querySelector('button[data-slot="increment"]');

        if (!memberLabel || !input || !plus) {
            if (!STATE.unavailableSince) STATE.unavailableSince = Date.now();
            const waited = Date.now() - STATE.unavailableSince;
            if (waited >= CONFIG.soldOutTimeout) advanceQueue('MEMBER TIDAK ADA', '#b91c1c');
            return false;
        }

        const current = Number(input.getAttribute('aria-valuenow') || input.value || 0);

        if (current >= target.quantity) {
            STATE.unavailableSince = null;
            STATE.memberSelected = true;
            setStatus(`${target.member} terpilih (${current}). Klik Submit Bonus...`);
            notifyCmdOnce(
                `member_${currentIndex}`,
                'PILIH MEMBER',
                `${target.member} | ${target.session} (${current} tiket)`
            );
            return true;
        }

        if (!enabled(plus)) {
            if (!STATE.unavailableSince) STATE.unavailableSince = Date.now();
            const waited = Date.now() - STATE.unavailableSince;
            const sisa = Math.max(0, ((CONFIG.soldOutTimeout - waited) / 1000)).toFixed(1);

            setStatus(`${target.member} SOLD OUT (${sisa}d)...`, '#b45309');

            if (waited >= CONFIG.soldOutTimeout) {
                advanceQueue('SOLD OUT', '#b91c1c');
            }
            return false;
        }

        STATE.unavailableSince = null;

        const needed = target.quantity - current;
        for (let i = 0; i < needed; i++) {
            setTimeout(() => {
                const nowVal = Number(input.getAttribute('aria-valuenow') || input.value || 0);
                if (nowVal < target.quantity && enabled(plus)) {
                    clickElement(plus);
                }
            }, i * 15);
        }

        setStatus(`Memilih ${target.member} (${target.quantity}x)...`);
        return false;
    }

    function scrollToTopInstant() {
        window.scrollTo({ top: 0, behavior: 'instant' });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;

        document.querySelectorAll('div, main, section').forEach(el => {
            if (el.scrollTop > 0) {
                el.scrollTop = 0;
            }
        });
    }

    // 6. Klik tombol Submit Bonus & langsung scroll ke atas
    function clickSubmitBonus() {
        if (STATE.submitClicked) return false;

        const submitBtn = [...document.querySelectorAll('button')].find(btn => {
            if (!visible(btn)) return false;
            const spanText = btn.querySelector('span')?.innerText || btn.innerText;
            return normalize(spanText) === 'submit bonus';
        });

        if (!submitBtn || !enabled(submitBtn)) return false;

        if (clickElement(submitBtn)) {
            STATE.submitClicked = true;
            scrollToTopInstant();
            setTimeout(scrollToTopInstant, 150);
            setStatus('Submit Bonus diklik. Scroll ke atas untuk cek harga...');
            return true;
        }

        return false;
    }

    // 7. Pilih Metode Pembayaran
    function selectPaymentMethod() {
        if (STATE.paymentSelected) return false;

        const paymentCard = [...document.querySelectorAll('div.cursor-pointer')].find(card => {
            if (!visible(card)) return false;
            const checkbox = card.querySelector('button[role="checkbox"]');
            const label = [...card.querySelectorAll('p')].find(p =>
                normalize(p.textContent) === normalize(CONFIG.paymentMethod)
            );
            return checkbox && label;
        });

        if (!paymentCard) return false;

        scrollToTopInstant();

        const priceEl = [...document.querySelectorAll('p, span, div')].find(el => {
            if (!visible(el) || el.children.length > 0) return false;
            const txt = (el.textContent || '').trim();
            return /^(rp\.?\s*[\d.,]+|[\d.,]+\s*(p|point))$/i.test(txt);
        });
        const priceInfo = priceEl ? ` | Total: ${priceEl.textContent.trim()}` : '';

        const checkbox = paymentCard.querySelector('button[role="checkbox"]');
        const isChecked = checkbox.getAttribute('aria-checked') === 'true' ||
            checkbox.getAttribute('data-state') === 'checked';

        if (isChecked) {
            STATE.paymentSelected = true;
            setStatus(`Metode (${CONFIG.paymentMethod}) terpilih${priceInfo}. Menyetujui S&K...`);
            notifyCmdOnce(
                `payment_${currentIndex}`,
                'PEMBAYARAN',
                `Metode: ${CONFIG.paymentMethod}${priceInfo}`
            );
            return true;
        }

        if (clickElement(checkbox) || clickElement(paymentCard)) {
            setStatus(`Memilih ${CONFIG.paymentMethod}${priceInfo}...`);
            return false;
        }

        return false;
    }

    // 8. Centang Syarat & Ketentuan
    function acceptTermsAndConditions() {
        if (STATE.termsAccepted) return false;

        const checkbox = document.querySelector('#checkbox-condition');
        if (!checkbox || !visible(checkbox)) return false;

        const isChecked = checkbox.getAttribute('aria-checked') === 'true' ||
            checkbox.getAttribute('data-state') === 'checked';

        if (isChecked) {
            STATE.termsAccepted = true;
            setStatus('S&K tercentang. Menekan Konfirmasi Pembelian...');
            return true;
        }

        const agreeBtn = [...document.querySelectorAll('button')].find(btn => {
            if (!visible(btn) || !enabled(btn)) return false;
            const spanText = btn.querySelector('span')?.innerText || btn.innerText;
            const txt = normalize(spanText);
            return txt.includes('menyetujui syarat & ketentuan') ||
                txt.includes('menyetujui syarat dan ketentuan') ||
                txt.includes('setuju');
        });

        if (agreeBtn) {
            clickElement(agreeBtn);
            setStatus('Mengklik tombol Menyetujui Syarat & Ketentuan...');
            return false;
        }

        const openDialog = document.querySelector('[role="dialog"][data-state="open"], [role="dialog"]');
        if (openDialog && visible(openDialog)) {
            const scrollable = [...openDialog.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight);
            if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
            return false;
        }

        if (enabled(checkbox)) {
            clickElement(checkbox);
            setStatus('Mencentang Syarat & Ketentuan...');
            return false;
        }

        const dialogTrigger = checkbox.closest('[aria-haspopup="dialog"]') || checkbox.parentElement?.parentElement;
        if (dialogTrigger && dialogTrigger.getAttribute('data-state') !== 'open') {
            clickElement(dialogTrigger);
            setStatus('Membuka popup Syarat & Ketentuan...');
        }

        return false;
    }

    // 9. Klik tombol Konfirmasi Pembelian
    function clickConfirmPurchase() {
        if (STATE.confirmClicked) return false;

        if (!CONFIG.autoConfirmPurchase) {
            STATE.completed = true;
            setStatus('SIAP! Silakan klik Konfirmasi Pembelian secara manual.');
            return true;
        }

        const confirmBtn = [...document.querySelectorAll('button')].find(btn => {
            if (!visible(btn)) return false;
            const spanText = btn.querySelector('span')?.innerText || btn.innerText;
            return normalize(spanText) === 'konfirmasi pembelian';
        });

        if (!confirmBtn || !enabled(confirmBtn)) return false;

        if (clickElement(confirmBtn)) {
            STATE.confirmClicked = true;
            setStatus('Konfirmasi Pembelian diklik! Menunggu /purchase/success...');
            notifyCmdOnce(
                `confirm_${currentIndex}`,
                'PEMBAYARAN',
                'Konfirmasi Pembelian diklik! Memproses transaksi...'
            );
            return true;
        }

        return false;
    }

    function run() {
        if (isInWaitingRoom()) {
            setStatus('Standby di Waiting Room (menunggu tembus / sync cookie)...', '#1d4ed8');
            return;
        }

        captureNewEventUrl();

        if (location.pathname.includes('/purchase/success')) {
            advanceQueue('SUKSES', '#15803d');
            return;
        }

        const target = getCurrentTarget();
        if (!target) {
            STATE.completed = true;
            sessionStorage.removeItem(STORAGE_KEY);
            sessionStorage.removeItem(DETECTED_URL_KEY);
            return;
        }

        if (STATE.busy || STATE.completed || STATE.successHandled) return;

        STATE.busy = true;

        try {
            if (selectFirstPhotobook()) return;

            if (!STATE.buyClicked) {
                if (clickBuyButton()) return;
            }

            if (!STATE.dateSelected) {
                if (chooseDateOption(target)) return;
                selectDate(target);
                return;
            }

            if (!STATE.sessionSelected) {
                if (selectSession(target)) return;
            }

            if (!STATE.memberSelected) {
                if (!selectMember(target)) return;
            }

            if (!STATE.submitClicked) {
                if (!clickSubmitBonus()) return;
            }

            if (!STATE.paymentSelected) {
                if (!selectPaymentMethod()) return;
            }

            if (!STATE.termsAccepted) {
                if (!acceptTermsAndConditions()) return;
            }

            if (!STATE.confirmClicked) {
                clickConfirmPurchase();
                return;
            }

        } catch (error) {
            console.error('[JKT48 AUTO ERROR]', error);
        } finally {
            STATE.busy = false;
        }
    }

    chrome.storage.local.get(['jkt48Queue', 'jkt48Payment'], (res) => {
        if (Array.isArray(res.jkt48Queue) && res.jkt48Queue.length > 0) {
            CONFIG.queue = res.jkt48Queue;
        }
        if (res.jkt48Payment) {
            CONFIG.paymentMethod = res.jkt48Payment;
        }
        configLoaded = true;
        setInterval(run, CONFIG.interval);
        setStatus('Aktif. Menunggu halaman pembelian...');
        run();
    });
})();