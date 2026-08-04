/**
 * Facebook-only browser automation.
 *
 * Queueing, profile lifecycle, persistence and logging remain in the shared
 * runner. This file owns every Facebook selector and page interaction.
 */
const fs = require('fs');
const path = require('path');

class FacebookAutomation {
  constructor(options = {}) {
    this.buildVarMap = options.buildVarMap || (post => ({
      ...post,
      media: post?.media ?? post?.image_path ?? '',
    }));
    this.renderTemplate = options.renderTemplate || ((template, values) => String(template || '').replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => values[key] == null ? '' : String(values[key])
    ));
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : ms => new Promise(resolve => setTimeout(resolve, ms));
    this._commentVerificationTimeoutMs = options.commentVerificationTimeoutMs;
    this._commentUploadTimeoutMs = options.commentUploadTimeoutMs;
  }

  _log(profileName, message, type = 'info') {
    this.log(message, type, profileName);
  }

  async publish(page, post) {
    if (!page) throw new Error('Khong co tab trinh duyet');

    const XP_TIMEOUT = 30000;
    const vmap = this.buildVarMap(post);
    const content = this.renderTemplate('{{content}}', vmap);
    const mediaRaw = this.renderTemplate('{{media}}', vmap);
    const humanDelay = (min = 900, max = 2600) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);

    await this._gotoFacebookPage(page, 'https://www.facebook.com/', 60000);
    await humanDelay(2500, 4500);

    // Kiem tra dang nhap bang cookie c_user - tin hieu dang tin cay nhat. Tranh false-positive cua cach
    // do chu "login/dang nhap" trong body (trang da dang nhap van co the chua cac tu nay o menu/footer).
    const getCUser = async () => ((await page.cookies('https://www.facebook.com').catch(() => [])).find(x => x.name === 'c_user') || {}).value;
    let cUser = await getCUser();
    if (!cUser) {
      // Man hinh "Chao mung tro lai / chon tai khoan": FB nho tai khoan nhung chua kich hoat phien
      // (chua co c_user) cho toi khi bam "Tiep tuc/Continue". Mo tay thi nguoi dung bam -> vao binh thuong;
      // tool phai tu bam nut nay thi moi co session. Thu toi 3 lan.
      for (let attempt = 0; attempt < 3 && !cUser; attempt++) {
        const contBtn = await page.evaluateHandle(() => {
          const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 15 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const nodes = Array.from(document.querySelectorAll('[role="button"], button, a, div[tabindex]')).filter(vis);
          return nodes.find(e => { const t = norm(e.innerText || ''); return t === 'continue' || t === 'tiep tuc'; })
            || nodes.find(e => { const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')); return t.includes('continue') || t.includes('tiep tuc'); })
            || null;
        }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
        if (!contBtn) break;
        await humanDelay();
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          contBtn.click().catch(() => {}),
        ]);
        await humanDelay(2500, 4500);
        cUser = await getCUser();
      }
    }
    if (!cUser) {
      // Van chua co c_user -> that su chua dang nhap (man hinh nhap mat khau/tao tai khoan).
      throw new Error('Facebook chua vao session dang nhap (can dang nhap lai profile)');
    }

    let profileHref = cUser ? `https://www.facebook.com/profile.php?id=${cUser}` : await this.getFacebookTimelineHref(page);
    if (!profileHref) throw new Error('B2: Khong lay duoc link timeline profile');

    let owner = await this.getProfileOwner(page, profileHref);

    // Bat buoc vao dung trang profile cua cookie c_user truoc khi crawl va dang bai; khong lay link tu feed/home.
    await this._gotoFacebookPage(page, profileHref, 60000);
    await humanDelay(3500, 6000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this.prepareTimelineForScan(page);
    owner = this._mergeOwner(owner, await this._readOwnerFromPage(page));
    if (owner.vanity) profileHref = `https://www.facebook.com/${owner.vanity}`;
    const beforeLinks = new Set(await this._extractTopOwnPostLinks(page, owner, 3));

    // Vao lai dung trang profile desktop de dang bai.
    await this._gotoFacebookPage(page, profileHref, 60000);
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(800, 1500);

    // Lay handle modal "Tao bai viet" hien tai (dialog HIEN THI co o soan / tieu de tao bai viet),
    // KHONG lay dialog dau tien (co the la dialog Thong bao an).
    const getModal = () => page.evaluateHandle(() => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
      const vis = e => { const r = e.getBoundingClientRect(); const s2 = getComputedStyle(e); return r.width > 200 && r.height > 150 && s2.visibility !== 'hidden' && s2.display !== 'none'; };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis);
      return dialogs.find(d => {
        if (d.querySelector('div[contenteditable="true"], [role="textbox"]')) return true;
        const t = norm((d.getAttribute('aria-label') || '') + ' ' + (d.innerText || '').slice(0, 80));
        return t.includes('tao bai viet') || t.includes('create post');
      }) || null;
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    // Mo composer: lay HANDLE nut composer uu tien "Ban dang nghi gi?", scrollIntoView roi click
    // (dung handle.click de tu cuon toi - tranh loi nut nam ngoai viewport khi dung toa do tinh).
    let modal = await getModal();
    if (!modal) {
      const composerBtn = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
        let best = null, bestScore = -1;
        Array.from(document.querySelectorAll('[role="button"], div[tabindex]')).forEach(e => {
          if (!visible(e)) return;
          const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || ''));
          let pr = 0;
          if (t.includes('ban dang nghi gi') || t.includes("what's on your mind")) pr = 3;
          else if (t.includes('tao bai viet') || t.includes('create post')) pr = 2;
          else if (t.includes('chia se suy nghi')) pr = 1;
          if (!pr) return;
          const r = e.getBoundingClientRect();
          const score = pr * 1e7 + r.width * r.height;
          if (score > bestScore) { bestScore = score; best = e; }
        });
        return best;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (composerBtn) {
        for (let attempt = 0; attempt < 3 && !modal; attempt++) {
          await page.keyboard.press('Escape').catch(() => {});
          await humanDelay(400, 800);
          await composerBtn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
          await humanDelay(500, 900);
          await composerBtn.click().catch(() => {});
          for (let t = 0; t < 8 && !modal; t++) { await this._sleep(1000); modal = await getModal(); }
        }
      }
    }
    if (!modal) {
      try {
        const dbg = await page.evaluate(() => {
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none'; };
          return {
            url: location.href, title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            dialogCount: document.querySelectorAll('[role="dialog"]').length,
            visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).map(d => (d.innerText || '').replace(/\s+/g, ' ').slice(0, 80)),
            body: (document.body.innerText || '').slice(0, 1200),
          };
        });
        fs.writeFileSync(path.join(__dirname, '..', '..', 'composer-debug.json'), JSON.stringify(dbg, null, 2));
      } catch (_) {}
      throw new Error('B5: Khong mo duoc o soan bai (Tao bai viet)');
    }
    await humanDelay(1500, 2500);

    // O soan noi dung trong modal
    let editable = await modal.evaluateHandle(root => {
      const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
      const boxes = Array.from(root.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'));
      return boxes.find(visible) || null;
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
    if (editable) { await editable.click(); await humanDelay(600, 1200); }
    if (content && content.trim()) {
      await page.keyboard.type(content, { delay: 25 });
      await humanDelay(1200, 2200);
    }

    // Dinh media (neu co) - tim nut Anh/video TRONG modal
    const mediaPaths = String(mediaRaw || '').split(',').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p)).filter(p => fs.existsSync(p));
    const hasVideo = mediaPaths.some(p => /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(p));
    if (mediaPaths.length > 0) {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: XP_TIMEOUT }),
        (async () => {
          const mediaBtn = await modal.evaluateHandle(root => {
            const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
            return Array.from(root.querySelectorAll('[role="button"], [aria-label]')).find(e => norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).includes('anh/video')) || null;
          }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
          if (!mediaBtn) throw new Error('B6: Khong thay nut Anh/video');
          await humanDelay();
          await mediaBtn.click();
        })(),
      ]);
      await fileChooser.accept(mediaPaths);
      await this._sleep(4000 + mediaPaths.length * 2500);
      await humanDelay(1200, 2500);
    }

    // Bam nut Dang (khop chinh xac de tranh nham "Dang tai..."). Xu ly buoc "Tiep" neu co.
    // Xac nhan thanh cong bang cach modal "Tao bai viet" bien mat.
    let posted = false;
    for (let step = 0; step < 20 && !posted; step++) {
      const cur = await getModal();
      if (!cur) { posted = true; break; } // modal da dong -> da dang xong
      const clickInfo = await cur.evaluate(root => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const enabled = e => e.getAttribute('aria-disabled') !== 'true' && !e.matches('[disabled]');
        const parts = e => [norm(e.getAttribute('aria-label') || ''), norm(e.innerText || '')].filter(Boolean);
        const isSubmit = e => parts(e).some(p => p === 'dang' || p === 'post' || p === 'dang bai' || p === 'dang bai viet');
        const isNext = e => parts(e).some(p => p === 'tiep' || p === 'tiep tuc' || p === 'next');
        const nodes = Array.from(root.querySelectorAll('[role="button"], button')).filter(visible);
        let pick = nodes.find(e => enabled(e) && isSubmit(e));
        let kind = 'dang';
        if (!pick) { pick = nodes.find(e => enabled(e) && isNext(e)); kind = 'tiep'; }
        if (!pick) return null;
        const r = pick.getBoundingClientRect();
        return { kind, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }).catch(() => null);
      if (clickInfo) {
        await humanDelay();
        await page.mouse.click(clickInfo.x, clickInfo.y).catch(() => {});
        await humanDelay(2000, 3500);
        if (clickInfo.kind === 'dang') {
          // cho modal dong (toi 8s)
          for (let w = 0; w < 8; w++) { const m = await getModal(); if (!m) { posted = true; break; } await this._sleep(1000); }
        }
      } else {
        await this._sleep(1500);
      }
    }
    if (!posted) throw new Error('B7: Khong tim thay/khong bam duoc nut Dang');

    const publishedAtMs = Date.now();
    const postedAt = new Date(publishedAtMs).toLocaleString('vi-VN');
    await this._sleep(8000);
    // Cach chinh (on dinh nhat): tim bai theo noi dung roi HOVER len timestamp -> FB tu inject permalink vao href.
    let postLink = await this.capturePostLinkByHover(page, profileHref, content, owner, beforeLinks);
    if (!postLink) postLink = await this.captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner, 3);
    if (!postLink) postLink = await this.captureNewTimelinePostLink(page, profileHref, beforeLinks, content, owner);
    if (!postLink && hasVideo) {
      // Video profile thuong duoc Facebook xu ly thanh Reel va khong mount trong card timeline.
      // Duyet cac Reel/video moi nhat, mo tung link va chi nhan link co caption khop noi dung da dang.
      this._log(null, 'Timeline chua co link video; dang doi chieu caption trong tab Reels/Video...', 'info');
      postLink = await this.captureReelByCaption(page, profileHref, content, owner, 6);
      if (postLink) this._log(null, `Da lay duoc link Reel theo caption: ${postLink}`, 'success');
    }

    return { success: true, postedAt, publishedAtMs, postLink, profileHref };
  }

  /**
   * Mo lai bai vua dang, gui text/media va chi thanh cong khi DOM xac nhan.
   * @param {Object} page - Puppeteer page
   * @param {string} postLink - Permalink bai da dang
   * @param {string} commentText - Noi dung binh luan (da render bien)
   * @param {string} mediaPath - Mot anh hoac video tuy chon
   */
  async commentOnPost(page, postLink, commentText = '', mediaPath = '') {
    const humanDelay = (min = 900, max = 2200) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);
    await this._gotoCommentPermalink(page, postLink);
    await humanDelay(3000, 5000);

    const box = await this._findCommentBox(page);
    if (!box) throw new Error('Không tìm thấy ô bình luận');
    const before = await this._commentDomSnapshot(page, commentText);

    await box.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await humanDelay(600, 1200);
    await box.click().catch(() => {});
    await humanDelay(500, 1000);

    if (mediaPath) {
      if (!fs.existsSync(mediaPath)) throw new Error(`Không tìm thấy media bình luận: ${mediaPath}`);
      await this._attachCommentMedia(page, box, mediaPath);
    }

    const lines = String(commentText).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 20 });
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
    await humanDelay(800, 1500);
    await this._submitComment(page, box);
    const submitError = new Error('Facebook chưa xác minh bình luận mới');
    submitError.submitted = true;

    const isVideo = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
    const timeoutMs = this._commentVerificationTimeoutMs || (isVideo ? 120000 : 45000);
    const started = Date.now();
    let lastAfter = null;
    while (Date.now() - started < timeoutMs) {
      await this._sleep(1800);
      const clean = await box.evaluate(el => !(el.innerText || '').trim()).catch(() => true);
      const after = await this._commentDomSnapshot(page, commentText);
      lastAfter = after;
      const newId = after.ids.some(id => !before.ids.includes(id));
      const textAdded = commentText ? after.textMatches > before.textMatches : true;
      const mediaAdded = mediaPath ? after.mediaCount > before.mediaCount : true;
      const attachmentCleared = mediaPath ? !after.composerHasAttachment : true;
      if (clean && ((commentText && textAdded) || (!commentText && newId)) && mediaAdded) {
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
      if (clean && newId && (!commentText || textAdded)) {
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
      // Facebook does not always expose comment_id immediately. For media
      // comments, a cleared editor and attachment preview after clicking the
      // explicit submit button is a reliable acknowledgement from the UI.
      if (mediaPath && clean && attachmentCleared && Date.now() - started >= 4500
        && (!commentText || textAdded)) {
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
    }
    submitError.message += ` | before=${JSON.stringify(before)} after=${JSON.stringify(lastAfter)}`;
    throw submitError;
  }

  async _findCommentBox(page) {
    let box = null;
    for (let attempt = 0; attempt < 8 && !box; attempt++) {
      box = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const vis = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const boxes = Array.from(document.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'
        )).filter(vis);
        return boxes.find(b => /binh luan|comment|tra loi|reply/.test(norm(
          (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('aria-placeholder') || '')
        ))) || boxes[boxes.length - 1] || null;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (!box) {
        await page.evaluate(() => window.scrollBy(0, 650)).catch(() => {});
        await this._sleep(1200);
      }
    }
    return box;
  }

  async _attachCommentMedia(page, box, mediaPath) {
    const isVideo = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
    const beforePreviewCount = await box.evaluate(el => {
      const visible = node => {
        const r = node.getBoundingClientRect();
        return r.width >= 50 && r.height >= 40 && r.bottom > 0 && r.top < innerHeight;
      };
      let root = el.closest('form');
      if (!root) {
        root = el;
        for (let i = 0; i < 9 && root.parentElement; i++) root = root.parentElement;
      }
      return Array.from(document.querySelectorAll('img,video')).filter(visible).length;
    }).catch(() => 0);

    let input = await box.evaluateHandle(el => {
      let cur = el;
      for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
        const found = cur.querySelector('input[type="file"]');
        if (found) return found;
      }
      return document.querySelector('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    if (input && typeof input.uploadFile === 'function') {
      await input.uploadFile(mediaPath);
    } else {
      const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
      const clicked = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 5 && r.height > 5; };
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]')).filter(vis);
        const button = nodes.find(e => /dinh kem.*(anh|video)|attach.*(photo|video)|anh.*video|photo.*video/.test(
          norm((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || ''))
        ));
        if (!button) return false;
        button.click();
        return true;
      }).catch(() => false);
      if (!clicked) throw new Error('Không tìm thấy nút đính kèm media bình luận');
      const chooser = await chooserPromise;
      await chooser.accept([mediaPath]);
    }

    const uploadTimeout = this._commentUploadTimeoutMs || (isVideo ? 120000 : 45000);
    const started = Date.now();
    while (Date.now() - started < uploadTimeout) {
      await this._sleep(1500);
      const state = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const busy = Array.from(document.querySelectorAll('[role="progressbar"], [aria-label]')).some(e =>
          /dang tai|uploading|processing/.test(norm((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')))
        );
        const previews = Array.from(document.querySelectorAll('img, video')).filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 80 && r.height > 50 && r.bottom > 0 && r.top < innerHeight;
        }).length;
        const removeButton = Array.from(document.querySelectorAll('[aria-label]')).some(e => {
          const r = e.getBoundingClientRect();
          const label = String(e.getAttribute('aria-label') || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return r.width > 5 && r.height > 5
            && /(go|remove) (anh|video|photo|image)/.test(label);
        });
        const pageText = String(document.body.innerText || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const attachmentSuccess = /a dinh kem (anh|video).*thanh cong|attached (photo|video|image).*success/.test(pageText);
        return { busy, previews, removeButton, attachmentSuccess };
      }).catch(() => ({
        busy: false, previews: 0, removeButton: false, attachmentSuccess: false
      }));
      // Facebook keeps unrelated page-level "loading" aria labels mounted,
      // so global busy state is not meaningful. A new visible media preview
      // compared with the pre-upload snapshot is the reliable signal.
      if (state.attachmentSuccess
        || state.previews > beforePreviewCount
        || (state.removeButton && Date.now() - started >= 3000)) return;
    }
    throw new Error('Media bình luận upload quá thời gian');
  }

  async _submitComment(page, box) {
    const button = await box.evaluateHandle(el => {
      const norm = s => String(s || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[Ä‘Ä]/g, 'd').toLowerCase();
      const visible = node => {
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return r.width > 5 && r.height > 5
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      let root = el.closest('form');
      if (!root) {
        root = el;
        for (let i = 0; i < 9 && root.parentElement; i++) root = root.parentElement;
      }
      return Array.from(root.querySelectorAll('[role="button"], button, [aria-label]')).find(node =>
        visible(node) && /ang binh luan|post comment/.test(norm(
          (node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')
        ))
      ) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    if (button) {
      await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
      const rect = await button.boundingBox().catch(() => null);
      if (rect && rect.width > 0 && rect.height > 0) {
        await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      } else {
        await button.click();
      }
      return;
    }
    await box.click().catch(() => {});
    await page.keyboard.press('Enter');
  }

  async _commentDomSnapshot(page, commentText = '') {
    const needle = String(commentText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    return page.evaluate((needle) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ids = [];
      for (const a of document.querySelectorAll('a[href*="comment_id="], a[href*="reply_comment_id="]')) {
        try {
          const u = new URL(a.href, location.href);
          const id = u.searchParams.get('comment_id') || u.searchParams.get('reply_comment_id');
          if (id && !ids.includes(id)) ids.push(id);
        } catch (_) {}
      }
      const candidates = Array.from(document.querySelectorAll('[role="article"], li, div'))
        .filter(e => e.children.length < 80 && e.getBoundingClientRect().height > 10);
      const textMatches = needle
        ? candidates.filter(e => norm(e.innerText).includes(needle)).length
        : 0;
      const mediaCount = candidates.reduce((count, e) => {
        const commentLink = e.querySelector('a[href*="comment_id="], a[href*="reply_comment_id="]');
        return count + (commentLink ? e.querySelectorAll('img,video').length : 0);
      }, 0);
      const normLabel = s => String(s || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[Ä‘Ä]/g, 'd').toLowerCase();
      const composerHasAttachment = Array.from(
        document.querySelectorAll('[aria-label], [role="button"]')
      ).some(e => {
        const r = e.getBoundingClientRect();
        if (r.width <= 5 || r.height <= 5) return false;
        return /go (anh|video)|remove (photo|video)/.test(normLabel(
          (e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')
        ));
      });
      return { ids, textMatches, mediaCount, composerHasAttachment };
    }, needle).catch(() => ({
      ids: [], textMatches: 0, mediaCount: 0, composerHasAttachment: false
    }));
  }

  async hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    await this._gotoCommentPermalink(page, postLink);
    await this._sleep(3500);
    const needle = String(commentText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    return page.evaluate((needle, wantsMedia) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const anchors = Array.from(document.querySelectorAll('a[href*="comment_id="], a[href*="reply_comment_id="]'));
      return anchors.some(anchor => {
        let cur = anchor;
        for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
          const textOk = !needle || norm(cur.innerText).includes(needle);
          const mediaOk = !wantsMedia || !!cur.querySelector('img,video');
          if (textOk && mediaOk) return true;
        }
        return false;
      });
    }, needle, !!mediaPath).catch(() => false);
  }

  async _gotoCommentPermalink(page, postLink) {
    return this._gotoFacebookPage(page, postLink, 30000);
  }

  async _gotoFacebookPage(page, url, timeout = 60000) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (error) {
      // Facebook may keep navigation pending while the permalink DOM is
      // already usable. Continue only when the target page and a real body
      // are present; otherwise preserve the original navigation failure.
      const usable = await page.evaluate((expected) => {
        try {
          const current = new URL(location.href);
          const target = new URL(expected);
          return current.hostname.endsWith('facebook.com')
            && target.hostname.endsWith('facebook.com')
            && !!document.body
            && (document.body.innerText || '').trim().length > 0;
        } catch (_) {
          return false;
        }
      }, url).catch(() => false);
      if (!usable) throw error;
      await page.evaluate(() => window.stop()).catch(() => {});
    }
  }

  // Lay permalink bai vua dang: cuon tim bai theo noi dung (needle), hover len link timestamp
  // ngay tren noi dung -> Facebook inject permalink that vao href (timestamp bi xao tron ky tu + href rong
  // cho toi khi hover). Doc href qua elementFromPoint. Day la cach on dinh nhat vi timeline ao hoa + href lazy.
  async capturePostLinkByHover(page, profileHref, content, owner, beforeLinks) {
    const needle = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 45);
    if (!needle) return '';
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    let own = { vanity: (owner && owner.vanity) || null, id: (owner && owner.id) || null };
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      // Resolve vanity tu canonical de _isOwnPostUrl khop dung (owner truyen vao co the thieu vanity).
      if (!own.vanity) {
        const v = await page.evaluate(() => {
          const c = document.querySelector('link[rel="canonical"]');
          try { const u = new URL((c && c.href) || location.href); const s = u.pathname.split('/').filter(Boolean); if (s[0] && s[0] !== 'profile.php') return s[0]; } catch (e) {}
          return null;
        }).catch(() => null);
        if (v) own.vanity = v;
      }
      // cuon cho toi khi co it nhat 1 bai chua needle xuat hien
      let found = false;
      for (let s = 0; s < 12 && !found; s++) {
        found = await page.evaluate((needle) => {
          const norm = x => String(x || '').replace(/\s+/g, ' ');
          return Array.from(document.querySelectorAll('div,span,p')).some(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        }, needle).catch(() => false);
        if (!found) { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); await this._sleep(1200); }
      }
      if (!found) continue;
      await this._sleep(1500);

      // Duyet MOI node khop needle: scroll node vao giua, lay link timestamp NGAY TREN noi dung
      // va PHAI nam trong viewport (tranh loi node trung lap nam ngoai man hinh -> hover truot).
      const cands = await page.evaluate((needle) => {
        const norm = s => String(s || '').replace(/\s+/g, ' ');
        const nodes = Array.from(document.querySelectorAll('div,span,p')).filter(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        for (const node of nodes) {
          node.scrollIntoView({ block: 'center' });
          const nr = node.getBoundingClientRect();
          const ts = Array.from(document.querySelectorAll('a[role="link"], a[href]')).map(a => {
            const r = a.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top, left: r.left, w: r.width, h: r.height };
          }).filter(a => a.w > 0 && a.h > 0 && a.h < 40 && a.top < nr.top - 8 && a.top > nr.top - 95
            && a.left >= nr.left - 30 && a.left < nr.left + 280
            && a.top > 40 && (a.top + a.h) < window.innerHeight - 20) // trong viewport
            .sort((p, q) => q.top - p.top)
            .slice(0, 4)
            .map(a => ({ x: a.x, y: a.y }));
          if (ts.length) return ts;
        }
        return [];
      }, needle).catch(() => []);

      for (const c of cands) {
        await page.mouse.move(c.x, c.y).catch(() => {});
        await this._sleep(1400);
        const href = await page.evaluate((xy) => {
          const el = document.elementFromPoint(xy.x, xy.y);
          const a = el && el.closest ? el.closest('a[href]') : null;
          return a ? a.href : '';
        }, c).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        // reel/watch/videos khong mang vanity trong path nen _isOwnPostUrl khong xac thuc duoc,
        // nhung chung den tu timestamp cua dung bai (needle) nen chap nhan.
        const ownOrMedia = this._isOwnPostUrl(clean, own) || /\/(reel|watch|videos)\//.test(clean);
        if (clean && this.looksLikeFacebookPostUrl(clean) && ownOrMedia && !before.has(clean)) {
          return clean;
        }
      }
    }
    return '';
  }

  /**
   * Gom ID video moi nhat tu tab Reels va Video cua profile.
   * Facebook co the dung URL vanity (/user/reels/) hoac profile.php?id=...&sk=...
   */
  async _reelIdsFromTabs(page, profileHref, owner = null) {
    const tabUrls = [];
    const add = (url) => {
      if (url && !tabUrls.includes(url)) tabUrls.push(url);
    };

    const own = owner || {};
    if (own.vanity) {
      const base = `https://www.facebook.com/${encodeURIComponent(String(own.vanity))}`;
      add(`${base}/reels/`);
      add(`${base}/videos`);
    }
    if (own.id) {
      const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(String(own.id))}`;
      add(`${base}&sk=reels_tab`);
      add(`${base}&sk=videos`);
    }

    // Neu owner thieu vanity/id, thu chuan hoa tu URL/canonical cua trang profile.
    if (tabUrls.length === 0) {
      try {
        await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(1500);
        const resolved = await page.evaluate(() => {
          const canonical = document.querySelector('link[rel="canonical"]');
          return (canonical && canonical.href) || location.href;
        }).catch(() => page.url());
        const u = new URL(resolved || profileHref, 'https://www.facebook.com');
        const segs = u.pathname.split('/').filter(Boolean);
        if (/^profile\.php$/i.test(segs[0] || '') && u.searchParams.get('id')) {
          const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(u.searchParams.get('id'))}`;
          add(`${base}&sk=reels_tab`);
          add(`${base}&sk=videos`);
        } else if (segs[0]) {
          const base = `https://www.facebook.com/${encodeURIComponent(decodeURIComponent(segs[0]))}`;
          add(`${base}/reels/`);
          add(`${base}/videos`);
        }
      } catch (_) {}
    }

    const ids = [];
    for (const url of tabUrls) {
      if (this.shouldStop) break;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(Math.floor(Math.random() * 1501) + 3000);
        for (let i = 0; i < 2; i++) {
          await page.mouse.wheel({ deltaY: 1400 }).catch(async () => {
            await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
          });
          await this._sleep(1200);
        }
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        ).catch(() => []);
        for (const href of hrefs) {
          const match = String(href || '').match(/\/(?:reel|videos)\/(\d+)/i);
          if (match && !ids.includes(match[1])) ids.push(match[1]);
        }
      } catch (_) {}
    }
    return ids;
  }

  /**
   * Video tren profile thuong thanh Reel va khong xuat hien trong card timeline.
   * Mo cac Reel moi nhat, doi chieu caption that roi moi tra permalink.
   */
  async captureReelByCaption(page, profileHref, content, owner = null, maxCheck = 6) {
    const needle = String(content || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    if (!needle) return '';

    const ids = await this._reelIdsFromTabs(page, profileHref, owner);
    for (const id of ids.slice(0, Math.max(1, maxCheck))) {
      if (this.shouldStop) break;
      const url = `https://www.facebook.com/reel/${id}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(Math.floor(Math.random() * 1301) + 2500);
        const body = await page.evaluate(() =>
          String(document.body.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
        ).catch(() => '');
        if (body.includes(needle)) return url;
      } catch (_) {}
    }
    return '';
  }

  async getFacebookTimelineHref(page) {
    const href = await page.evaluate(() => {
      const pick = (a) => a && a.href && /^https:\/\/www\.facebook\.com\//.test(a.href) ? a.href : '';
      const direct = Array.from(document.querySelectorAll('a[role="link"][aria-label*="DÃƒÂ²ng thÃ¡Â»Âi gian"]'))[0];
      if (pick(direct)) return direct.href;
      const imgLink = Array.from(document.querySelectorAll('a[role="link"][href*="facebook.com/"]')).find(a => a.querySelector('image, img, svg'));
      return pick(imgLink);
    }).catch(() => '');
    return this.normalizeFacebookPostUrl(href, true);
  }

  normalizeFacebookPostUrl(href, keepProfile = false) {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const host = u.hostname.replace(/^(www|m|mbasic|touch|web)\./, '');
      if (host !== 'facebook.com') return '';
      u.protocol = 'https:';
      u.hostname = 'www.facebook.com';
      const dropExact = new Set(['__tn__', 'comment_id', 'refid', 'ref', '_rdr', 'eav', 'sfnsn', 'mibextid', 'paipv', 'rdid', 'notif_t', 'notif_id', 'idorvanity']);
      for (const key of Array.from(u.searchParams.keys())) {
        if (key.startsWith('__cft__') || dropExact.has(key)) u.searchParams.delete(key);
      }
      if (!keepProfile && !this.looksLikeFacebookPostUrl(u.toString())) return '';
      return u.toString();
    } catch { return ''; }
  }

  looksLikeFacebookPostUrl(href) {
    // Bao gom ca video/reel/watch (FB thuong dang video ngan thanh Reel -> permalink dang /reel/<id>).
    return /\/posts\/|\/permalink\/|\/photo(?:\.php|s\/)|\/videos\/|\/reel\/|\/watch\/|story_fbid=|fbid=|multi_permalinks=/.test(String(href || ''));
  }

  async prepareTimelineForScan(page) {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await this._sleep(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1500);
  }

  async scanTimelinePostLinks(page, limit = 20) {
    await this.prepareTimelineForScan(page);
    const raw = await page.evaluate((limit) => {
      const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
      const fromArticles = articles.flatMap((article, articleIndex) => {
        const text = article.innerText || '';
        return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text, href: a.href }));
      });
      const global = Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => ({ articleIndex: 1000 + i, text: a.innerText || a.getAttribute('aria-label') || '', href: a.href }));
      return fromArticles.concat(global).slice(0, 800);
    }, limit).catch(() => []);
    return [...new Set(raw.map(x => this.normalizeFacebookPostUrl(x.href)).filter(h => h && this.looksLikeFacebookPostUrl(h)))];
  }


  async scanTopOwnPostLinks(page, profileHref, owner = null, limit = 3) {
    await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await this._sleep(3500);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1000);
    return await this._extractTopOwnPostLinks(page, owner, limit);
  }

  async captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner = null, limit = 3) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(1000);
      const after = await this._extractTopOwnPostLinks(page, owner, limit);
      const found = after.find(h => !before.has(h));
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-top3.json'), JSON.stringify({
          attempt, owner, profileHref, before: [...before], after, found
        }, null, 2));
      } catch (e) {}
      if (found) return found;
    }
    return '';
  }

  async _extractTopOwnPostLinks(page, owner = null, limit = 3) {
    const raw = await page.evaluate((limit, owner) => {
      const vanity = owner && owner.vanity ? String(owner.vanity).toLowerCase() : '';
      const id = owner && owner.id ? String(owner.id) : '';
      const isPost = (href) => {
        const s = String(href || '');
        if (!/\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(s)) return false;
        try {
          const u = new URL(s, location.href);
          const first = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
          if (vanity && first === vanity && /\/posts\//.test(u.pathname)) return true;
          if (id && u.searchParams.get('id') === id) return true;
          if (id && first === id) return true;
          return !vanity && !id;
        } catch (_) { return false; }
      };
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => {
          const r = a.getBoundingClientRect();
          const article = a.closest('[role="article"]');
          return { i, top: Math.round(r.top), left: Math.round(r.left), href: a.href, text: ((article && article.innerText) || a.innerText || a.getAttribute('aria-label') || '').slice(0, 300) };
        })
        .filter(x => isPost(x.href))
        .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.i - b.i))
        .slice(0, Math.max(limit * 5, 30));
    }, limit, owner || {}).catch(() => []);
    const seen = new Set();
    const links = [];
    for (const x of raw) {
      const clean = this.normalizeFacebookPostUrl(x.href);
      if (!clean || !/\/posts\/|permalink|story_fbid=/.test(clean)) continue;
      if (!this._isOwnPostUrl(clean, owner)) continue;
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push(clean);
      if (links.length >= limit) break;
    }
    return links;
  }

  async captureNewTimelinePostLink(page, profileHref, beforeLinks, content = '', owner = null) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    const needle = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const isGoodPost = (h) => /\/posts\/|permalink|story_fbid=/.test(h);
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(800);
      // BÃƒÂ i mÃ¡Â»â€ºi thÃ†Â°Ã¡Â»Âng khÃƒÂ´ng nÃ¡ÂºÂ±m trong [role=article] -> tÃƒÂ¬m permalink ngay quanh vÃƒÂ¹ng text bÃƒÂ i mÃ¡Â»â€ºi
      const nearLink = await this._captureNewPostNearText(page, needle, before, owner);
      if (nearLink) return nearLink;
      await this.prepareTimelineForScan(page);
      const scan = await page.evaluate((limit, needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
        const fromArticles = articles.flatMap((article, articleIndex) => {
          const text = article.innerText || '';
          return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text: text.slice(0, 1200), href: a.href }));
        });
        const global = Array.from(document.querySelectorAll('a[href]'))
          .map((a, i) => ({ articleIndex: 1000 + i, text: (a.innerText || a.getAttribute('aria-label') || '').slice(0, 1200), href: a.href }));
        const needleArt = needle ? articles.find(a => norm(a.innerText).includes(needle)) : null;
        let needleHrefs = [];
        if (needle) {
          const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
          let node = null;
          for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
          let cur = node, hops = 0;
          while (cur && hops < 12) {
            const hs = Array.from(cur.querySelectorAll('a[href]')).map(a => a.href);
            if (hs.some(h => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(h))) { needleHrefs = [...new Set(hs)].slice(0, 40); break; }
            cur = cur.parentElement; hops++;
          }
        }
        return {
          links: fromArticles.concat(global).slice(0, 800),
          needleFound: !!needleArt,
          bodyHasNeedle: needle ? norm(document.body.innerText).includes(needle) : false,
          articleCount: articles.length,
          needleHrefs
        };
      }, 20, needle).catch(() => ({ links: [], needleFound: false, bodyHasNeedle: false, articleCount: 0, needleHrefs: [] }));
      const raw = scan.links || [];
      const normed = raw.map(x => ({ ...x, href: this.normalizeFacebookPostUrl(x.href) }))
        .filter(x => x.href && this.looksLikeFacebookPostUrl(x.href));
      const picked = normed
        .filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner))
        .map(x => ({ ...x, score: (needle && x.text.includes(needle) ? 100 : 0) + (20 - Math.min(x.articleIndex, 20)) + (/\/posts\//.test(x.href) ? 5 : 0) }))
        .sort((a,b)=>b.score-a.score)[0];
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-desktop.json'), JSON.stringify({
          attempt, profileHref, pageUrl: page.url(), owner, needle, beforeSize: before.size,
          needleFound: scan.needleFound, bodyHasNeedle: scan.bodyHasNeedle, articleCount: scan.articleCount,
          needleHrefs: scan.needleHrefs,
          ownAll: [...new Set(normed.filter(x => this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          ownNew: [...new Set(normed.filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          picked: picked ? { href: picked.href, score: picked.score } : null
        }, null, 2));
      } catch (e) {}
      if (picked && picked.href && picked.score > 0 && /\/posts\/|permalink|story_fbid=/.test(picked.href)) return picked.href;
    }
    return '';
  }

  // LÃ¡ÂºÂ¥y danh tÃƒÂ­nh chÃ¡Â»Â§ account Ã„â€˜ang Ã„â€˜Ã„Æ’ng: vanity (username) + numeric id (tÃ¡Â»Â« cookie c_user)
  async getProfileOwner(page, profileHref) {
    let vanity = null, id = null;
    try {
      const u = new URL(profileHref, 'https://www.facebook.com');
      const segs = u.pathname.split('/').filter(Boolean);
      if (/^profile\.php$/i.test(segs[0] || '')) {
        id = u.searchParams.get('id') || null;
      } else if (segs[0] && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])) {
        vanity = decodeURIComponent(segs[0]);
      }
    } catch (_) {}
    try {
      const cookies = await page.cookies('https://www.facebook.com');
      const c = cookies.find(x => x.name === 'c_user');
      if (c && c.value) id = c.value;
    } catch (_) {}
    return { vanity, id };
  }

  // Ã„ÂÃ¡Â»Âc danh tÃƒÂ­nh chÃ¡Â»Â§ trang tÃ¡Â»Â« chÃƒÂ­nh trang profile Ã„â€˜ang mÃ¡Â»Å¸ (canonical/og:url) Ã„â€˜Ã¡Â»Æ’ lÃ¡ÂºÂ¥y Ã„â€˜Ã†Â°Ã¡Â»Â£c vanity khi profileHref lÃƒÂ  dÃ¡ÂºÂ¡ng sÃ¡Â»â€˜
  async _readOwnerFromPage(page) {
    return await page.evaluate(() => {
      const out = { vanity: null, id: null };
      const can = document.querySelector('link[rel="canonical"]');
      const og = document.querySelector('meta[property="og:url"]');
      const url = (can && can.href) || (og && og.content) || '';
      try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean);
        if (/^profile\.php$/i.test(segs[0] || '')) out.id = u.searchParams.get('id');
        else if (segs[0] && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])) out.vanity = decodeURIComponent(segs[0]);
      } catch (e) {}
      try {
        const html = document.documentElement.innerHTML;
        const m = html.match(/"userID":"(\d+)"/) || html.match(/"entity_id":"(\d+)"/) || html.match(/"owner_id":"(\d+)"/);
        if (m && !out.id) out.id = m[1];
      } catch (e) {}
      return out;
    }).catch(() => ({ vanity: null, id: null }));
  }

  _mergeOwner(a, b) {
    a = a || {}; b = b || {};
    return { vanity: a.vanity || b.vanity || null, id: a.id || b.id || null };
  }

  // LÃ¡ÂºÂ¥y nhanh vanity/id chÃ¡Â»Â§ account tÃ¡Â»Â« canonical cÃ¡Â»Â§a trang mobile (khÃƒÂ´ng quÃƒÂ©t bÃƒÂ i) Ã¢â‚¬â€ mobile trÃ¡ÂºÂ£ canonical Ã¡Â»â€¢n Ã„â€˜Ã¡Â»â€¹nh hÃ†Â¡n desktop

  // Link cÃƒÂ³ thuÃ¡Â»â„¢c Ã„â€˜ÃƒÂºng account Ã„â€˜ang Ã„â€˜Ã„Æ’ng khÃƒÂ´ng (chÃ¡Â»â€˜ng lÃ¡ÂºÂ¥y nhÃ¡ÂºÂ§m bÃƒÂ i ngÃ†Â°Ã¡Â»Âi khÃƒÂ¡c trÃƒÂªn timeline)
  _isOwnPostUrl(href, owner) {
    if (!owner || (!owner.vanity && !owner.id)) return true;
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const idParam = u.searchParams.get('id');
      if (owner.id && idParam && String(idParam) === String(owner.id)) return true;
      // Ã¡ÂºÂ¢nh: owner id nÃ¡ÂºÂ±m trong set=pb.<id>.- hoÃ¡ÂºÂ·c set=a....<id>
      const setParam = u.searchParams.get('set') || '';
      if (owner.id && new RegExp('(?:^|[.:])' + owner.id + '(?:[.:]|$)').test(setParam)) return true;
      const segs = u.pathname.split('/').filter(Boolean);
      const first = segs[0] ? decodeURIComponent(segs[0]).toLowerCase() : '';
      if (owner.vanity && first === String(owner.vanity).toLowerCase()) return true;
      if (owner.id && first === String(owner.id)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // TÃƒÂ¬m permalink cÃ¡Â»Â§a bÃƒÂ i vÃ¡Â»Â«a Ã„â€˜Ã„Æ’ng bÃ¡ÂºÂ±ng cÃƒÂ¡ch leo DOM tÃ¡Â»Â« chÃƒÂ­nh Ã„â€˜oÃ¡ÂºÂ¡n text nÃ¡Â»â„¢i dung (khÃƒÂ´ng phÃ¡Â»Â¥ thuÃ¡Â»â„¢c [role=article])
  async _captureNewPostNearText(page, needle, before, owner) {
    if (!needle) return '';
    const pick = (href) => {
      const clean = this.normalizeFacebookPostUrl(href);
      if (clean && !before.has(clean) && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) return clean;
      return '';
    };
    try {
      const containerHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
        let node = null;
        for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
        if (!node) return null;
        let cur = node, hops = 0;
        while (cur && hops < 12) {
          const has = Array.from(cur.querySelectorAll('a[href]')).some(a => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(a.href));
          if (has) return cur;
          cur = cur.parentElement; hops++;
        }
        return node;
      }, needle);
      const el = containerHandle && containerHandle.asElement ? containerHandle.asElement() : null;
      if (!el) return '';
      const anchors = await el.$$('a[href]');
      // VÃƒÂ²ng 1: dÃƒÂ¹ng href sÃ¡ÂºÂµn cÃƒÂ³
      for (const a of anchors) {
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
      // VÃƒÂ²ng 2: hover Ã„â€˜Ã¡Â»Æ’ Facebook gÃ¡ÂºÂ¯n permalink
      for (const a of anchors.slice(0, 20)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(400);
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
    } catch (_) {}
    return '';
  }

  // Hover cÃƒÂ¡c link trong bÃƒÂ i khÃ¡Â»â€ºp nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Æ’ Facebook lÃ¡Â»â„¢ permalink timestamp, rÃ¡Â»â€œi lÃ¡ÂºÂ¥y link bÃƒÂ i cÃ¡Â»Â§a Ã„â€˜ÃƒÂºng chÃ¡Â»Â§ account
  async _hoverRevealPostLink(page, needle, before, owner) {
    try {
      const artHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const arts = Array.from(document.querySelectorAll('[role="article"]'));
        if (needle) { const m = arts.find(a => norm(a.innerText).includes(needle)); if (m) return m; }
        return arts[0] || null;
      }, needle);
      const artEl = artHandle && artHandle.asElement ? artHandle.asElement() : null;
      if (!artEl) return '';
      const anchors = await artEl.$$('a[role="link"], a[href]');
      for (const a of anchors.slice(0, 14)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(500);
        const href = await page.evaluate(el => el.href, a).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        if (clean && this.looksLikeFacebookPostUrl(clean) && !before.has(clean)
          && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) {
          return clean;
        }
      }
    } catch (_) {}
    return '';
  }

  /**
   * Stop the runner gracefully
   */
  _sleep(ms) {
    return this.sleep(ms);
  }
}

const FacebookAdapter = {
  publish(page, post, options = {}) {
    return new FacebookAutomation(options).publish(page, post);
  },

  comment(page, postLink, commentText = '', mediaPath = '', options = {}) {
    return new FacebookAutomation(options).commentOnPost(page, postLink, commentText, mediaPath);
  },

  hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    return new FacebookAutomation().hasExistingComment(page, postLink, commentText, mediaPath);
  },

  validateSession(page) {
    return page.cookies('https://www.facebook.com')
      .then(cookies => cookies.some(cookie => cookie.name === 'c_user' && cookie.value))
      .catch(() => false);
  },

  _private: { FacebookAutomation },
};

module.exports = FacebookAdapter;
