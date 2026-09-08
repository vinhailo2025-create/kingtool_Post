/**
 * Guided product tour for Super Post King.
 * The guide only navigates and highlights controls; it never runs a destructive action.
 */
const RobotGuide = {
  storageKey: 'super-post-robot-guide-v1',
  root: null,
  activeSteps: [],
  activeChapter: '',
  stepIndex: 0,
  target: null,
  origin: null,
  positionFrame: null,
  stepRunId: 0,
  openedAppModal: false,

  chapters: [
    {
      id: 'welcome',
      number: '01',
      title: 'Làm quen',
      description: 'Hiểu bố cục và cách di chuyển trong Super Post King.',
      tone: 'orange',
    },
    {
      id: 'browser',
      number: '02',
      title: 'Trình duyệt',
      description: 'Tạo, kết nối, mở, phân loại và quản lý nhóm Profile.',
      tone: 'blue',
    },
    {
      id: 'facebook',
      number: '03',
      title: 'Đăng Facebook',
      description: 'Một quy trình hoàn chỉnh từ dữ liệu đến Link Post.',
      tone: 'green',
    },
    {
      id: 'advanced',
      number: '04',
      title: 'Tính năng nâng cao',
      description: 'AI, Telegram, Agent/MCP và cập nhật tool.',
      tone: 'gold',
    },
  ],

  steps: [
    {
      chapter: 'welcome',
      selector: '[data-tour-id="app-brand"]',
      kicker: 'Bắt đầu',
      title: 'Chào mừng đến Super Post King',
      body: 'Đây là trung tâm quản lý nội dung và đăng bài đa nền tảng. Robot sẽ đi theo đúng màn hình, nút và khu vực đang được giới thiệu.',
    },
    {
      chapter: 'welcome',
      selector: '[data-tour-id="main-navigation"]',
      kicker: 'Bố cục',
      title: 'Mọi chức năng nằm ở thanh điều hướng',
      body: 'Phía trên là các nền tảng. Phía dưới là <strong>Hẹn giờ</strong>, <strong>Log chạy</strong> và <strong>Cài đặt</strong>. Mỗi nền tảng dùng chung kho Profile nhưng có dữ liệu và cấu hình riêng.',
    },

    {
      chapter: 'browser',
      selector: '#nav-browsers',
      kicker: 'Trình duyệt',
      title: 'Kho Profile dùng chung',
      body: 'Mở mục <strong>Trình duyệt</strong> để chuẩn bị các tài khoản sẽ dùng khi đăng bài. Một Profile có thể sử dụng cho nhiều nền tảng.',
    },
    {
      chapter: 'browser',
      page: 'browsers',
      selector: '[data-tour-id="browser-create"]',
      kicker: 'Tạo mới',
      title: 'Tạo một Profile Chrome',
      body: 'Dùng <strong>Tạo mới</strong> khi muốn tool quản lý một Profile Chrome riêng. Sau khi tạo, bấm <strong>Mở</strong> và đăng nhập tài khoản trực tiếp trong cửa sổ Chrome.',
    },
    {
      chapter: 'browser',
      page: 'browsers',
      selector: '[data-tour-id="browser-connect"]',
      kicker: 'Kết nối',
      title: 'Nhập Profile Anti-detect',
      body: 'Dùng nút này để kết nối GoLogin, GemLogin, GPM hoặc GenLogin. Tool liên kết Profile hiện có và không sao chép hay xóa dữ liệu gốc của phần mềm Anti-detect.',
    },
    {
      chapter: 'browser',
      page: 'browsers',
      selector: '[data-tour-id="browser-table"]',
      kicker: 'Quản lý',
      title: 'Mở và kiểm tra từng Profile',
      body: 'Mỗi dòng có trạng thái, loại trình duyệt, nhóm và thao tác. <strong>Mở</strong> để đăng nhập hoặc kiểm tra tài khoản; <strong>Sửa</strong> để đổi thông tin; <strong>Log</strong> để xem lịch sử.',
    },
    {
      chapter: 'browser',
      page: 'browsers',
      selector: '[data-tour-id="browser-groups"]',
      kicker: 'Phân loại',
      title: 'Tạo và quản lý nhóm Profile',
      body: 'Nhóm giúp lọc nhanh theo khách hàng, dự án hoặc mục đích sử dụng. Một Profile có thể thuộc nhiều nhóm; xóa nhóm chỉ gỡ nhãn, không xóa Profile.',
    },
    {
      chapter: 'browser',
      page: 'browsers',
      selector: '[data-tour-id="browser-filters"]',
      kicker: 'Lọc và thao tác',
      title: 'Tìm, lọc và thao tác nhiều Profile',
      body: 'Có thể lọc theo loại, theo nhóm hoặc tìm theo tên. Tích nhiều dòng để mở, đóng hoặc chuyển nhóm hàng loạt. Robot không tự bấm các thao tác này.',
    },

    {
      chapter: 'facebook',
      selector: '#nav-facebook',
      kicker: 'Quy trình mẫu',
      title: 'Làm quen quy trình đăng Facebook',
      body: 'Robot dùng Facebook làm ví dụ hoàn chỉnh. Các nền tảng khác cũng đi theo nguyên tắc: chuẩn bị Profile → dữ liệu → cấu hình → chạy → xem kết quả.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="data-grid"]',
      kicker: 'Dữ liệu',
      title: 'Mỗi hàng là một nội dung cần xử lý',
      body: 'Một hàng Facebook thường có <strong>Profile</strong>, caption, <strong>Media</strong>, Fanpage hoặc Group, trạng thái và <strong>Link Post</strong>. Chỉ hàng đang <strong>Chờ</strong> mới được lấy để chạy.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="data-profile-map"]',
      kicker: 'Mapping',
      title: 'Gán đúng Profile cho dữ liệu',
      body: 'Chọn một hoặc nhiều hàng rồi bấm <strong>Gán Profile</strong>. Tên được lưu vào cột <code>name_profile</code>; tool chỉ chạy hàng đã mapping đúng với Profile thật.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="data-target-map"]',
      kicker: 'Đích đăng',
      title: 'Chọn trang cá nhân, Fanpage hoặc Group',
      body: 'Để trống Fanpage và Group nếu đăng trang cá nhân. Chọn <strong>Fanpage</strong> để lấy đúng trang thuộc Profile; URL Group được nhập ở cột <code>Post_group</code>.',
    },
    {
      chapter: 'facebook',
      page: 'postcfg',
      platform: 'facebook',
      selector: '[data-tour-id="config-limit"]',
      kicker: 'Cấu hình',
      title: 'Giới hạn số bài mỗi lượt',
      body: 'Giới hạn được tính theo từng Profile trong một lượt. Các bài còn lại vẫn ở trạng thái chờ và chạy ở lượt kế tiếp theo khoảng nghỉ đã cấu hình.',
    },
    {
      chapter: 'facebook',
      page: 'postcfg',
      platform: 'facebook',
      selector: '[data-tour-id="config-antibot"]',
      kicker: 'An toàn',
      title: 'Thiết lập chống BOT và tốc độ thao tác',
      body: 'Khu vực này điều chỉnh hành vi đọc an toàn, tốc độ click, thời gian chờ và cách xử lý khi bước chuẩn bị gặp lỗi. Mỗi nền tảng có cấu hình riêng.',
    },
    {
      chapter: 'facebook',
      page: 'postcfg',
      platform: 'facebook',
      selector: '[data-tour-id="config-comments"]',
      kicker: 'Sau khi đăng',
      title: 'Nhãn AI và bình luận tự động',
      body: 'Facebook có thể bật Nhãn AI cho bài có media. Phần bình luận cho phép đặt nội dung, ảnh và khoảng chờ; lịch bình luận được lưu để phục hồi khi app mở lại.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="data-automation"]',
      kicker: 'Tự động hóa',
      title: 'Chọn Profile và bắt đầu quy trình',
      body: 'Sau khi chọn dữ liệu, mở <strong>Tự động hóa</strong>, chọn Profile rồi chọn Chạy ngay hoặc Hẹn giờ. Nhiều Profile có thể chạy đồng thời; các bài cùng Profile chạy tuần tự.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      openAutomation: true,
      selector: '[data-tour-id="automation-profiles"]',
      kicker: 'Bên trong Tự động hóa',
      title: 'Chọn đúng Profile sẽ chạy',
      body: 'Popup đã được mở để bạn xem. Tìm theo tên, lọc loại trình duyệt hoặc nhóm rồi tích một hay nhiều Profile. Robot chỉ hướng dẫn và không tự chọn tài khoản.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="automation-mode"]',
      kicker: 'Cách chạy',
      title: 'Chạy ngay hoặc chuyển sang Hẹn giờ',
      body: 'Chọn <strong>Chạy ngay</strong> để xử lý các hàng đang Chờ. Chọn <strong>Hẹn giờ</strong> để đặt thời điểm chạy; cấu hình giới hạn và delay vẫn lấy từ tool.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="automation-run"]',
      kicker: 'Xác nhận',
      title: 'Bấm Chạy khi đã kiểm tra xong',
      body: 'Nút <strong>Chạy</strong> bắt đầu tác vụ thật. Robot dừng ở bước giới thiệu này và không tự bấm, tránh đăng nhầm dữ liệu.',
    },
    {
      chapter: 'facebook',
      page: 'runner',
      closeAppModal: true,
      selector: '[data-tour-id="runner-log"]',
      kicker: 'Realtime',
      title: 'Theo dõi tiến độ và lỗi',
      body: '<strong>queued</strong> là đang chờ, <strong>running</strong> là đang xử lý, <strong>success</strong> là đã thành công và <strong>error</strong> đi kèm nguyên nhân. Log được cập nhật theo thời gian thực.',
    },
    {
      chapter: 'facebook',
      page: 'data',
      platform: 'facebook',
      selector: '[data-tour-id="data-grid"]',
      kicker: 'Kết quả',
      title: 'Đọc trạng thái và Link Post',
      body: 'Khi hoàn tất, tool ghi trạng thái, thời gian và permalink vào đúng hàng. <strong>link_pending</strong> nghĩa là Facebook đã nhận bài nhưng tool vẫn đang dò link; không được đăng lại.',
    },
    {
      chapter: 'facebook',
      page: 'scheduler',
      selector: '[data-tour-id="scheduler-table"]',
      kicker: 'Hẹn giờ',
      title: 'Quản lý lịch đăng',
      body: 'Lịch có thể chạy một lần, hàng ngày hoặc theo cron. Tại đây bạn xem nền tảng, Profile, lần chạy gần nhất, đồng thời có thể bật, tắt hoặc chỉnh sửa lịch.',
    },

    {
      chapter: 'advanced',
      selector: '#nav-settings',
      kicker: 'Nâng cao',
      title: 'Các kết nối dùng chung',
      body: 'Mục Cài đặt tập trung AI, Agent/MCP, Telegram, tốc độ trình duyệt và kênh cập nhật chính thức.',
    },
    {
      chapter: 'advanced',
      page: 'settings',
      selector: '#settings-trigger-ai',
      kicker: 'AI',
      title: 'AI nội dung và tạo ảnh',
      body: 'Kết nối Gemini, OpenAI, 9Router, Kira hoặc ChatGPT trong app. Cấu hình dùng chung để viết lại nội dung và tạo ảnh cho các hàng đã chọn.',
    },
    {
      chapter: 'advanced',
      page: 'settings',
      selector: '#settings-trigger-telegram',
      kicker: 'Telegram',
      title: 'Thông báo và điều khiển từ xa',
      body: 'Telegram có thể nhận trạng thái quan trọng, gửi menu điều khiển, báo cáo và dùng AI để hiểu câu lệnh tự nhiên khi được bật.',
    },
    {
      chapter: 'advanced',
      page: 'settings',
      selector: '#settings-trigger-agent-mcp',
      kicker: 'Agent & MCP',
      title: 'Kết nối Claude, Codex và OpenClaw',
      body: 'Agent Kit tự cấu hình kết nối, theo dõi job realtime và sửa lại MCP khi cần. Key được quản lý nội bộ; không cần đưa key cho trợ lý AI.',
    },
    {
      chapter: 'advanced',
      page: 'settings',
      settingsSection: 'guide',
      selector: '.account-update-card',
      kicker: 'Cập nhật',
      title: 'Cập nhật mà không mất dữ liệu',
      body: 'Tải bản mới từ kênh chính thức, thoát tool cũ rồi chạy Setup để cài đè. Database, Profile và license nằm ở vùng dữ liệu riêng nên được giữ nguyên.',
    },
  ],

  init() {
    if (this.root) return;
    this.root = document.createElement('div');
    this.root.id = 'robot-guide-root';
    this.root.innerHTML = `
      <div class="robot-guide-center" aria-hidden="true"></div>
      <div class="robot-guide-tour" aria-hidden="true">
        <div class="robot-guide-spotlight"></div>
        <div class="robot-guide-progress" aria-hidden="true"></div>
        <section class="robot-guide-card" role="dialog" aria-modal="false"
                 aria-labelledby="robot-guide-step-title" tabindex="-1"></section>
      </div>
    `;
    document.body.appendChild(this.root);
    window.addEventListener('resize', () => this.schedulePosition(), { passive: true });
    document.addEventListener('scroll', () => this.schedulePosition(), true);
    document.addEventListener('keydown', event => this.onKeyDown(event));
  },

  robotSvg() {
    return `
      <svg class="robot-guide-avatar-svg" viewBox="0 0 80 80" aria-hidden="true">
        <path class="robot-guide-antenna" d="M40 17V9m0 0 7-5m-7 5-7-5"/>
        <rect class="robot-guide-ear" x="8" y="34" width="9" height="21" rx="4"/>
        <rect class="robot-guide-ear" x="63" y="34" width="9" height="21" rx="4"/>
        <rect class="robot-guide-head" x="15" y="17" width="50" height="48" rx="17"/>
        <rect class="robot-guide-face" x="22" y="27" width="36" height="27" rx="10"/>
        <circle class="robot-guide-eye" cx="33" cy="40" r="3.5"/>
        <circle class="robot-guide-eye" cx="47" cy="40" r="3.5"/>
        <path class="robot-guide-smile" d="M34 48c4 3 8 3 12 0"/>
        <circle class="robot-guide-signal" cx="47" cy="4" r="4"/>
      </svg>
    `;
  },

  readProgress() {
    try {
      const value = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
      return {
        completed: Array.isArray(value.completed) ? value.completed : [],
        last: value.last && typeof value.last === 'object' ? value.last : null,
      };
    } catch (_) {
      return { completed: [], last: null };
    }
  },

  writeProgress(progress) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(progress));
    } catch (_) {}
  },

  open() {
    this.init();
    this.stopTour({ restore: false });
    const center = this.root.querySelector('.robot-guide-center');
    center.innerHTML = `
      <div class="robot-guide-center-backdrop" onclick="RobotGuide.close()"></div>
      <section class="robot-guide-center-panel robot-guide-entry-panel" role="dialog"
               aria-modal="true" tabindex="-1" aria-labelledby="robot-guide-entry-title">
        <header class="robot-guide-center-header">
          <div class="robot-guide-avatar robot-guide-avatar-large">${this.robotSvg()}</div>
          <div>
            <span class="robot-guide-kicker">Trung tâm hướng dẫn</span>
            <h2 id="robot-guide-entry-title">Bạn muốn xem hướng dẫn nào?</h2>
            <p>Chọn BOT để được dẫn trực tiếp trên giao diện, hoặc mở video và tài liệu đầy đủ.</p>
          </div>
          <button class="robot-guide-icon-button" type="button" onclick="RobotGuide.close()"
                  aria-label="Đóng hướng dẫn">×</button>
        </header>
        <div class="robot-guide-help-choices">
          <button class="robot-guide-help-choice is-bot" type="button"
                  onclick="RobotGuide.openBot()">
            <span class="robot-guide-help-icon">${this.robotSvg()}</span>
            <span class="robot-guide-help-copy">
              <small>Đi theo từng nút</small>
              <strong>BOT hướng dẫn</strong>
              <span>Robot làm nổi đúng vị trí, chuyển trang và giải thích từng bước sử dụng tool.</span>
            </span>
            <b aria-hidden="true">→</b>
          </button>
          <button class="robot-guide-help-choice is-docs" type="button"
                  onclick="RobotGuide.openDocuments()">
            <span class="robot-guide-help-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <rect x="9" y="12" width="46" height="36" rx="8"/>
                <path d="m27 24 14 8-14 8z"/>
                <path d="M19 54h26M24 48v6M40 48v6"/>
              </svg>
            </span>
            <span class="robot-guide-help-copy">
              <small>Xem và tra cứu</small>
              <strong>Video &amp; tài liệu</strong>
              <span>Mở playlist hướng dẫn, tài liệu Google Docs và thông tin cập nhật tool.</span>
            </span>
            <b aria-hidden="true">→</b>
          </button>
        </div>
      </section>
    `;
    center.classList.add('is-open');
    center.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => center.querySelector('.robot-guide-center-panel')?.focus());
  },

  openBot() {
    this.init();
    this.stopTour({ restore: false });
    const progress = this.readProgress();
    const center = this.root.querySelector('.robot-guide-center');
    const completed = new Set(progress.completed);
    const chapterCards = this.chapters.map(chapter => {
      const stepCount = this.steps.filter(step => step.chapter === chapter.id).length;
      return `
        <button type="button" class="robot-guide-chapter robot-guide-tone-${chapter.tone}"
                onclick="RobotGuide.start('${chapter.id}')">
          <span class="robot-guide-chapter-number">${chapter.number}</span>
          <span class="robot-guide-chapter-copy">
            <strong>${chapter.title}</strong>
            <small>${chapter.description}</small>
          </span>
          <span class="robot-guide-chapter-meta">
            ${completed.has(chapter.id) ? '<i>Đã xem</i>' : `<i>${stepCount} bước</i>`}
            <b aria-hidden="true">→</b>
          </span>
        </button>
      `;
    }).join('');
    const canResume = progress.last
      && ['all', ...this.chapters.map(chapter => chapter.id)].includes(progress.last.chapter)
      && Number.isInteger(progress.last.index);

    center.innerHTML = `
      <div class="robot-guide-center-backdrop" onclick="RobotGuide.close()"></div>
      <section class="robot-guide-center-panel" role="dialog" aria-modal="true" tabindex="-1"
               aria-labelledby="robot-guide-center-title">
        <header class="robot-guide-center-header">
          <div class="robot-guide-avatar robot-guide-avatar-large">${this.robotSvg()}</div>
          <div>
            <span class="robot-guide-kicker">Robot hướng dẫn</span>
            <h2 id="robot-guide-center-title">Bạn muốn khám phá phần nào?</h2>
            <p>Robot sẽ đi theo đúng nút trên giao diện và không tự thực hiện thao tác nguy hiểm.</p>
          </div>
          <button class="robot-guide-icon-button" type="button" onclick="RobotGuide.close()"
                  aria-label="Đóng hướng dẫn">×</button>
        </header>
        <div class="robot-guide-center-actions">
          <button class="robot-guide-primary" type="button" onclick="RobotGuide.start('all')">
            <span>▶</span> Học toàn bộ tool
          </button>
          ${canResume ? `
            <button class="robot-guide-secondary" type="button"
                    onclick="RobotGuide.resume()">
              Tiếp tục bước đang dở
            </button>
          ` : ''}
        </div>
        <div class="robot-guide-chapters">${chapterCards}</div>
        <footer class="robot-guide-center-footer">
          <button type="button" onclick="RobotGuide.openVideoGuide()">Xem video hướng dẫn</button>
          <a href="${Settings.supportLinks.docs}" target="_blank" rel="noopener noreferrer">Mở tài liệu Google Docs ↗</a>
          ${completed.size ? '<button type="button" onclick="RobotGuide.resetProgress()">Xóa tiến độ</button>' : ''}
        </footer>
      </section>
    `;
    center.classList.add('is-open');
    center.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => center.querySelector('.robot-guide-center-panel')?.focus());
  },

  openVideoGuide() {
    this.openDocuments();
  },

  openDocuments() {
    this.close();
    Settings.openGuideSection();
  },

  resetProgress() {
    this.writeProgress({ completed: [], last: null });
    this.openBot();
  },

  resume() {
    const last = this.readProgress().last;
    if (!last) return this.start('all');
    this.start(last.chapter, last.index);
  },

  async start(chapter = 'all', requestedIndex = 0) {
    this.init();
    if (typeof closeModal === 'function'
      && document.getElementById('modal-overlay')?.classList.contains('active')) {
      closeModal();
    }
    this.origin = {
      page: App.currentPage,
      platform: App.currentPlatform,
      scrollTop: document.getElementById('page-container')?.scrollTop || 0,
    };
    this.activeChapter = chapter;
    this.activeSteps = chapter === 'all'
      ? [...this.steps]
      : this.steps.filter(step => step.chapter === chapter);
    this.stepIndex = Math.min(
      Math.max(0, Number(requestedIndex) || 0),
      Math.max(0, this.activeSteps.length - 1)
    );
    this.root.querySelector('.robot-guide-center').classList.remove('is-open');
    this.root.querySelector('.robot-guide-center').setAttribute('aria-hidden', 'true');
    this.root.querySelector('.robot-guide-tour').classList.add('is-open');
    this.root.querySelector('.robot-guide-tour').setAttribute('aria-hidden', 'false');
    document.body.classList.add('robot-guide-active');
    await this.showStep();
  },

  async showStep() {
    const step = this.activeSteps[this.stepIndex];
    if (!step) return this.complete();
    this.clearTarget();
    const runId = ++this.stepRunId;
    this.saveCurrentStep();

    if (step.closeAppModal && this.openedAppModal) {
      if (typeof closeModal === 'function') closeModal();
      this.openedAppModal = false;
    }

    if (step.page) {
      const platformChanged = step.platform && step.platform !== App.currentPlatform;
      if (App.currentPage !== step.page || platformChanged) {
        App.navigateTo(step.page, step.platform || null);
      }
    }

    if (step.settingsSection) {
      await this.waitForSelector(`#settings-trigger-${step.settingsSection}`, 5000);
      if (runId !== this.stepRunId) return;
      Settings.toggleSection(step.settingsSection, true);
    }

    if (step.openAutomation) {
      await Automation.show();
      this.openedAppModal = true;
      if (runId !== this.stepRunId) return;
    }

    let target = await this.waitForSelector(step.selector, 5000);
    if (runId !== this.stepRunId) return;
    if (!target) target = document.getElementById('main-content');
    this.target = target;
    target?.classList.add('robot-guide-target');
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    await this.wait(320);
    if (runId !== this.stepRunId) return;

    const chapter = this.chapters.find(item => item.id === step.chapter);
    const card = this.root.querySelector('.robot-guide-card');
    const isLast = this.stepIndex === this.activeSteps.length - 1;
    card.innerHTML = `
      <div class="robot-guide-card-head">
        <div class="robot-guide-avatar">${this.robotSvg()}</div>
        <div>
          <span class="robot-guide-kicker">${step.kicker || chapter?.title || 'Hướng dẫn'}</span>
          <h3 id="robot-guide-step-title">${step.title}</h3>
        </div>
        <button class="robot-guide-icon-button" type="button"
                onclick="RobotGuide.close()" aria-label="Thoát hướng dẫn">×</button>
      </div>
      <div class="robot-guide-card-body">${step.body}</div>
      <div class="robot-guide-card-footer">
        <button class="robot-guide-back" type="button" onclick="RobotGuide.previous()"
                ${this.stepIndex === 0 ? 'disabled' : ''}>← Quay lại</button>
        <span>${this.stepIndex + 1}/${this.activeSteps.length}</span>
        <button class="robot-guide-next" type="button" onclick="RobotGuide.next()">
          ${isLast ? 'Hoàn thành' : 'Tiếp theo →'}
        </button>
      </div>
    `;
    this.renderProgress(chapter);
    this.position();
    requestAnimationFrame(() => card.focus({ preventScroll: true }));
  },

  renderProgress(chapter) {
    const progress = this.root.querySelector('.robot-guide-progress');
    const percent = ((this.stepIndex + 1) / this.activeSteps.length) * 100;
    progress.innerHTML = `
      <span>${chapter?.number || '•'}</span>
      <div><strong>${this.activeChapter === 'all' ? 'Làm quen toàn bộ tool' : chapter?.title}</strong>
        <i style="width:${percent}%"></i>
      </div>
      <small>${Math.round(percent)}%</small>
    `;
  },

  async next() {
    if (this.stepIndex >= this.activeSteps.length - 1) return this.complete();
    this.stepIndex += 1;
    await this.showStep();
  },

  async previous() {
    if (this.stepIndex <= 0) return;
    this.stepIndex -= 1;
    await this.showStep();
  },

  complete() {
    const progress = this.readProgress();
    if (this.activeChapter === 'all') {
      progress.completed = this.chapters.map(chapter => chapter.id);
    } else if (!progress.completed.includes(this.activeChapter)) {
      progress.completed.push(this.activeChapter);
    }
    progress.last = null;
    this.writeProgress(progress);
    this.stopTour({ restore: false });

    const center = this.root.querySelector('.robot-guide-center');
    center.innerHTML = `
      <div class="robot-guide-center-backdrop" onclick="RobotGuide.close()"></div>
      <section class="robot-guide-complete" role="dialog" aria-modal="true">
        <div class="robot-guide-complete-glow"></div>
        <div class="robot-guide-avatar robot-guide-avatar-large">${this.robotSvg()}</div>
        <span class="robot-guide-kicker">Hoàn thành</span>
        <h2>Bạn đã sẵn sàng sử dụng Super Post King</h2>
        <p>Có thể mở lại robot bất kỳ lúc nào từ nút Hướng dẫn sử dụng.</p>
        <div>
          <button class="robot-guide-primary" type="button" onclick="RobotGuide.openBot()">Chọn chương khác</button>
          <button class="robot-guide-secondary" type="button" onclick="RobotGuide.close()">Đóng</button>
        </div>
      </section>
    `;
    center.classList.add('is-open');
    center.setAttribute('aria-hidden', 'false');
  },

  close() {
    this.stopTour({ restore: true });
    const center = this.root?.querySelector('.robot-guide-center');
    center?.classList.remove('is-open');
    center?.setAttribute('aria-hidden', 'true');
  },

  stopTour({ restore = false } = {}) {
    if (!this.root) return;
    this.clearTarget();
    if (this.openedAppModal) {
      if (typeof closeModal === 'function') closeModal();
      this.openedAppModal = false;
    }
    this.root.querySelector('.robot-guide-tour')?.classList.remove('is-open');
    this.root.querySelector('.robot-guide-tour')?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('robot-guide-active');
    if (restore && this.origin) {
      const origin = this.origin;
      this.origin = null;
      if (origin.page && (
        App.currentPage !== origin.page
        || (App.workspacePages.includes(origin.page) && App.currentPlatform !== origin.platform)
      )) {
        App.navigateTo(origin.page, origin.platform || null);
      }
      requestAnimationFrame(() => {
        const pageContainer = document.getElementById('page-container');
        if (pageContainer) pageContainer.scrollTop = origin.scrollTop || 0;
      });
    }
  },

  clearTarget() {
    this.stepRunId += 1;
    if (this.target) this.target.classList.remove('robot-guide-target');
    this.target = null;
    cancelAnimationFrame(this.positionFrame);
  },

  saveCurrentStep() {
    const progress = this.readProgress();
    progress.last = { chapter: this.activeChapter, index: this.stepIndex };
    this.writeProgress(progress);
  },

  async waitForSelector(selector, timeoutMs = 4000) {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (const value of selectors) {
        const element = document.querySelector(value);
        if (element && this.isVisible(element)) return element;
      }
      await this.wait(100);
    }
    return null;
  },

  isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden';
  },

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  schedulePosition() {
    if (!this.target || !this.root?.querySelector('.robot-guide-tour.is-open')) return;
    cancelAnimationFrame(this.positionFrame);
    this.positionFrame = requestAnimationFrame(() => this.position());
  },

  position() {
    if (!this.target) return;
    const rect = this.target.getBoundingClientRect();
    const spotlight = this.root.querySelector('.robot-guide-spotlight');
    const card = this.root.querySelector('.robot-guide-card');
    const padding = 9;
    spotlight.style.left = `${Math.max(8, rect.left - padding)}px`;
    spotlight.style.top = `${Math.max(8, rect.top - padding)}px`;
    spotlight.style.width = `${Math.min(window.innerWidth - 16, rect.width + padding * 2)}px`;
    spotlight.style.height = `${Math.min(window.innerHeight - 16, rect.height + padding * 2)}px`;

    if (window.innerWidth <= 720) {
      card.style.left = '12px';
      card.style.right = '12px';
      card.style.top = 'auto';
      card.style.bottom = '12px';
      return;
    }

    card.style.right = 'auto';
    card.style.bottom = 'auto';
    const cardWidth = Math.min(370, window.innerWidth - 32);
    const cardHeight = card.offsetHeight || 280;
    const gap = 20;
    let left = rect.right + gap;
    let top = rect.top + (rect.height - cardHeight) / 2;
    if (left + cardWidth > window.innerWidth - 16) left = rect.left - cardWidth - gap;
    if (left < 16) {
      left = Math.min(window.innerWidth - cardWidth - 16, Math.max(16, rect.left));
      top = rect.bottom + gap;
      if (top + cardHeight > window.innerHeight - 16) top = rect.top - cardHeight - gap;
    }
    top = Math.min(window.innerHeight - cardHeight - 16, Math.max(16, top));
    card.style.width = `${cardWidth}px`;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  },

  onKeyDown(event) {
    if (!this.root) return;
    if (this.root.querySelector('.robot-guide-tour.is-open')) {
      if (event.key === 'Escape') this.close();
      if (event.key === 'ArrowRight') this.next();
      if (event.key === 'ArrowLeft') this.previous();
      return;
    }
    if (event.key === 'Escape' && this.root.querySelector('.robot-guide-center.is-open')) {
      this.close();
    }
  },
};

document.addEventListener('DOMContentLoaded', () => RobotGuide.init());
