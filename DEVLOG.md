# AgentRunlog — Geliştirme Günlüğü (DEVLOG)

> Bu döküman, **AgentRunlog** projesinin geliştirme sürecindeki tüm adımları, alınan mimari kararları, karşılaşılan teknik engelleri ve **neyin neden yapıldığını** kronolojik ve detaylı olarak kayıt altına alır.

---

## [2026-11-11] — Faz 0: Başlangıç, Saha Araştırması ve Mimari Denetim (Argon)

### 1. PRD Analizi ve Repo Kurulumu
- **Ne Yapıldı:**
  - `https://github.com/trgysvc/AgentRunlog.git` reposu klonlandı.
  - Kullanıcının ilettiği `Ajan Hafıza Eklentisi — PRD.pdf` dökümanı incelendi ve `docs/` altına kopyalandı.
  - `.gitignore` oluşturularak PRD belgeleri ve ham kayıtlar (`.agentrunlog/raw/`) git dışı bırakıldı.
  - `README.md` projenin 3 katmanlı Karpathy Wiki mimarisini ve 4 hedef platformu (Claude Code, Antigravity, Cursor, Codex) yansıtacak şekilde baştan sona modernize edildi.

### 2. Sektördeki Sistemlerin Araştırılması (Neden Yapıldı?)
- **Araştırılan Sistemler:** `claude-mem`, `Cline / Roo-Code Memory Bank`, `Mem0`, `Karpathy LLM Wiki`.
- **Neden Yapıldı?**  
  Benzer araçların sahada nerede tıkandığını bilmeden kod yazmak, onların düştüğü tuzaklara düşmek demektir.
- **Kritik Bulgular ve Alınan Kararlar:**
  1. *claude-mem Tuzağı (Decision Drift):* Gözlemleri salt vektör DB'ye atmak, 1 ay önceki iptal edilmiş kararların semantik benzerlikten dolayı tekrar ajana kural gibi sunulmasına yol açıyor.  
     **Bizim Kararımız:** Vektör aramasına değil, deterministik `supersedes` / `supersededBy` grafına dayalı tipli karar modeli kurmak.
  2. *Cline Tuzağı (Token Bloat & Doc Drift):* Her sohbette 10.000+ token'lık bellek dosyalarını prompt'a yığmak ve ajana kod yazarken hafızayı güncelletmeye çalışmak ajanı yoruyor ve güncellemeler unutuluyor.  
     **Bizim Kararımız:** Ajanın omzuna derleme yükü bindirmemek. Out-of-band (arka planda asenkron) derleme ve sert **800 token tavanı**.
  3. *Mem0 Tuzağı (Evidence Deficit):* Varlık/olgu çıkarımı yapıp ham koda bağlamamak.  
     **Bizim Kararımız:** Her kayda transkript satır/tur bağlamı (`evidence`) zorunluluğu.
  4. *False Dead-End Tuzağı:* Anlık ağ/syntax hatalarını "çıkmaz sokak" sanıp ajanın doğru yollarını kapatmak.  
     **Bizim Kararımız:** `Soft Guardrail (FR-20)` kuralı: Asla sert bloklama yok; zorunlu `retryConditions` uyarısı.

### 3. Argon Baş Mimar Denetimi & PRD v1.1
- Yapılan bulgular Argon'a sunuldu ve PRD'ye şu emniyet sübapları eklendi:
  - **FR-19 (Pre-compiled Context Cache):** Hook çalıştığı anda arama yapmasın, derleyicinin hazırladığı statik JSON dosyasını < 5ms içinde okusun (Terminal donmasını önler).
  - **NFR-05 (< 20ms Hook SLA):** Hook içinde LLM çağrısı kesinlikle yasaklandı (`ZERO_IN_HOOK_LLM`).
  - **NFR-09 (Çift Özyineleme Koruması):** `AGENTRUNLOG_INTERNAL=1` ile derleyicinin kendi kendini dinlemesi engellendi.

---

## [2026-11-11] — Faz 1: Çekirdek Altyapı (Core Foundation)

### 1. Tipli Veri Modelleri (`src/types/schemas.ts`)
- **Neden Yapıldı?**  
  Mühendislik hafızasının yapılandırılmamış serbest metin yerine katı tip güvenliğiyle çalışması için Zod şemaları tanımlandı.
- **Tanımlanan Tipler:**
  - `Decision`: Rasyonel, alternatifler, `supersedes`, `supersededBy`, `affectsModules`, `evidence`.
  - `RCA`: `incident`, `rootCause`, `resolution`, `preventativeActions`.
  - `DeadEnd`: `rootCauseType` ('architectural' | 'limitation'), `approach`, `whyFailed`, zorunlu `retryConditions`.
  - `Task` & `Run`: Yapılan işler ve komut koşu kayıtları.
  - `RawSessionEvent`: Oturum transkript olayları (`caller` meta verisi ile özyineleme korumalı).
  - `ActiveContextCache`: Hook'ların hızlı okuması için optimize edilmiş özet şema.

### 2. Gizli Veri Temizleyici (`src/sanitizer/index.ts`)
- **Neden Yapıldı (FR-12, NFR-01)?**  
  Ajanın terminal çıktılarında veya dosyalarında geçen API anahtarları ve şifrelerin diske (`raw/`) sızmasını engellemek.
- **Nasıl Yapıldı?**  
  - 10 farklı regex kuralı ile OpenAI, Anthropic, GitHub, AWS, Google Cloud, JWT, DB URI ve Key-Value şifreleri maskelenir.
  - Maskeleme deterministik hash kullanır: `[REDACTED:KIND:hash_prefix]`. Böylece ajan aynı anahtardan bahsettiği bağlamı korur ama gerçek sır asla diske yazılmaz.
- **Karşılaşılan Sorun ve Çözüm:**  
  `sk-` (OpenAI) regex'i `sk-ant-` (Anthropic) anahtarlarını yutuyordu. Regex öncelikleri ve negatif lookahead (`(?!ant)`) eklenerek çözüldü.

### 3. Atomik Depolama Motoru (`src/storage/`)
- **Neden Yapıldı?**  
  Çoklu ajan ve yarış durumlarında (race conditions) dosyaların bozulmaması için:
  - `SessionLogger`: İşletim sistemi seviyesinde atomik append (`flags: 'a'`) ile JSONL yazar.
  - `WikiManager`: Markdown frontmatter dosyalarını doğrudan üzerine yazmak yerine **geçici dosyaya yazıp atomik yeniden adlandırma (`renameSync`)** deseniyle yazar.
  - `ContextCacheManager`: `cache/active_context.json` dosyasını yönetir ve hook'lar için hazır Markdown çıktısı üretir.

- **Doğrulama:** 11 birim testi yazıldı ve hepsi başarıyla geçti (`11 passed`).

---

## [2026-11-11] — Faz 2: Yerel MCP Sunucusu (Pull Mekanizması)

### 1. MCP Standardı Entegrasyonu (`src/mcp/`)
- **Neden Yapıldı?**  
  Dört platformun (Claude Code, Antigravity, Cursor, Codex) ortak paydası Model Context Protocol (MCP)'dir. Ajanların ihtiyaç duydukları anda hafızayı doğrudan sorgulayabilmeleri sağlandı.
- **Sunulan Araçlar:**
  1. `search_runlog`: Anahtar kelime, modül ve tip filtreli arama. `supersededBy !== null` olan kararları otomatik eler (Decision Drift engeli).
  2. `get_decision`: Kararın bağlamını, kimin onayladığını ve supersede geçmişini döner.
  3. `get_rca`: Kök neden analizi ve çözümünü döner.
  4. `check_dead_ends`: **Soft Guardrail**. Ajan bir teknik yaklaşımı denemeden önce sorar; sistem daha önce patlayan yaklaşımları ve `retryConditions` şartını hatırlatır. Asla bloklamaz.
  5. `get_active_context`: Önceden derlenmiş aktif kararları < 5ms içinde getirir.
- **Karşılaşılan Sorun ve Çözüm:**  
  `preToolUse` gibi komutların içindeki `use` kelimesi rastgele bir komutu çıkmaz sokak sanıyordu. Stop-words filtresi ve tam kelime sınırı (`\b`) eklenerek kesin doğruluk sağlandı.
- **Doğrulama:** 4 yeni MCP testi eklendi; toplam test sayısı 15'e çıktı ve hepsi geçti (`15 passed`).

---

## [2026-11-11] — Faz 3: Derleyici Worker & Linter Motoru

### 1. Wiki Linter (`src/compiler/linter.ts`)
- **Neden Yapıldı (FR-11)?**  
  Zamanla kod değiştikçe hafızanın bayatlamasını ve çürümesini önlemek.
- **Denetlenen Kurallar:**
  - `BROKEN_SUPERSEDES_LINK`: Var olmayan bir kararı supersede ettiğini iddia eden kararlar.
  - `SUPERSEDED_MARKED_ACTIVE`: Yerine yenisi geçmiş ama durumu hala `active` kalmış kararlar.
  - `MISSING_RETRY_CONDITIONS`: `retryConditions` alanı boş bırakılmış çıkmaz sokaklar.
  - `STALE_MODULE_REF`: Kod tabanında artık var olmayan veya taşınmış dosya yolları.
  - `LOW_CONFIDENCE_ACTIVE`: Düşük güvenli olduğu halde aktif bırakılmış taslaklar.

### 2. Transkript Derleyici & Supersede Otomasyonu (`src/compiler/extractor.ts`)
- **Neden Yapıldı?**  
  Ham transkriptlerden çıkarılan kararların geçmiş kararlarla bağını kurmak ve her derlemede `active_context.json` dosyasını 800 token tavanı ile tazelemek.

### 3. Ham Transkriptten Sıfırdan Üretim (`src/compiler/reindex.ts`)
- **Neden Yapıldı (NFR-10)?**  
  Karpathy'nin *"Raw is source of truth, wiki is compiled view"* ilkesi gereğince, `wiki/` tamamen silinse dahi `reindex` ile sıfırdan üretilebilirlik garanti altına alındı.

- **Doğrulama:** 3 yeni derleyici testi eklendi; toplam test sayısı 18'e çıktı ve hepsi geçti (`18 passed`).

---

## [2026-11-11] — Faz 4: Platform Hook Adaptörleri

### 1. Dört Hedef Platformun Entegrasyonu (`src/hooks/`)
- **Neden Yapıldı?**  
  Her kodlama aracının (Claude Code, Antigravity, Cursor, Codex) olay (event) tetikleme mekanizması farklıdır. Sistemin bunlara ince, zero-delay adaptörlerle bağlanması sağlandı.
- **Geliştirilen Adaptörler:**
  1. `ClaudeCodeHookAdapter`: `.claude/hooks.json` üretir. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `PreCompact` olaylarını yakalar.
  2. `AntigravityHookAdapter`: `.agents/hooks.json` üretir. `PreInvocation` olayında oturum başı tespiti yapar ve context push eder, `PostInvocation` ve `Stop` olaylarını dinler.
  3. `CursorHookAdapter`: `.cursor/hooks.json` üretir. Ayrıca Cursor'da `SessionStart` hook'u olmadığı için **FR-14 gereğince `.cursorrules` kural şablonunu projeye ekler**. Ajan mimari bir karar almadan veya refactor yapmadan önce MCP araçlarını (`search_runlog`, `check_dead_ends`) sorgular.
  4. `CodexHookAdapter`: `.codex/hooks.json` üretir. `SessionStart` ve `Stop` yaşam döngüsünü bağlar.
  5. `HookManager`: Tek çağrıyla tüm platformları projeye kurar (`installAll()`).
- **Doğrulama:** 5 yeni hook birim testi eklendi ve tümü geçti (`23 passed`).

---

## [2026-11-11] — Faz 5: CLI & Uçtan Uca (E2E) Sistem Entegrasyonu

### 1. CLI Komut Arayüzü (`src/cli/index.ts`)
- **Neden Yapıldı?**  
  Geliştiricinin ve CI ortamlarının hafıza sistemini tek bir komutla (`runlog`) yönetebilmesi için.
- **Sunulan Komutlar:**
  - `runlog init [platform]`: `.agentrunlog/` hiyerarşisini kurar, platform hook'larını bağlar, `.gitignore`'a `.agentrunlog/raw/` ekler.
  - `runlog status`: Aktif/superseded kararlar, RCA, DeadEnd sayılarını ve token bütçesini gösterir.
  - `runlog lint`: `WikiLinter` çalıştırır; çelişkili veya kırık kayıtları raporlar.
  - `runlog reindex`: Ham loglardan tüm wiki'yi sıfırdan derler.
  - `runlog mcp`: MCP sunucusunu stdio üzerinden başlatır.
  - `runlog hook <plt> <evt>`: Hook olaylarını < 20ms sürede icra eder.

### 2. Uçtan Uca Entegrasyon Testi (`src/e2e.test.ts`)
- **Neden Yapıldı?**  
  Tüm parçaların gerçek bir senaryoda birlikte kusursuz çalıştığını kanıtlamak için.
- **Test Edilen Akış:**
  1. Claude Code oturumu başlar -> Hook yakalar.
  2. Kullanıcı veritabanı şifresi içeren bir prompt girer -> Sanitizer diske yazmadan önce şifreyi maskeler (`[REDACTED:PASSWORD:...]`).
  3. Compiler transkripti derler -> `DEC-001` (SQL) ve `DEAD-001` (Prisma on Edge) hafızaya yazılır.
  4. Antigravity oturumu başlar -> Hook aktif kararları otomatik ajana enjekte eder.
  5. Ajan `check_dead_ends` MCP aracını çağırır -> Soft Guardrail uyarısı ile `retryConditions` bildirilir.
  6. Mimari değişir: `DEC-002` (Drizzle) eklenir ve `DEC-001`'i supersede eder -> Ajan arama yaptığında eski karar elenir, yeni karar döner.
  7. Linter hafızayı tarar -> 0 hata ile geçer.
  8. `WikiReindexer` çalıştırılır -> Ham transkriptlerden tüm hafıza sıfırdan geri kazanılır (NFR-10).

- **Nihai Doğrulama:** 6 test dosyasında **26 birim ve entegrasyon testinin tamamı başarıyla geçti (`26 passed`)**.

---

## [2026-11-11] — Faz 6: Canlı Üretim Hazırlığı ve 5 Somut Eksiğin Tamamlanması

### 1. Gerçek LLM İstemcisi ve `runlog compile` Motoru (`src/compiler/llm-client.ts`)
- **Neden Yapıldı?**  
  Ham transkriptlerin gerçek bir LLM (Anthropic Claude 3.5 Haiku, OpenAI gpt-4o-mini, Gemini 1.5 Flash veya yerel Ollama) tarafından analiz edilip Zod tiplerine dönüştürülmesi için native `fetch` tabanlı çoklu sağlayıcı istemcisi yazıldı.
- **Ek Özellik:** API anahtarı olmadığında veya offline çalışıldığında geliştiriciyi yarı yolda bırakmayan `heuristicFallbackExtract` kural motoru eklendi.

### 2. Hook `stdin` Yakalama ve Detached Worker (`src/hooks/runner.ts`)
- **Neden Yapıldı (NFR-05, NFR-06, NFR-09)?**  
  Gerçek dünyada Claude Code, Cursor ve Antigravity hook verilerini `process.stdin` üzerinden JSON olarak verir. Non-blocking < 15ms `stdin` okuyucu kuruldu.
- `session-end`, `stop` veya `pre-compact` anında derleyici worker `spawn(..., { detached: true })` ve `AGENTRUNLOG_INTERNAL=1` bayrağı ile arka plana devredildi. Böylece ajanın terminali asla kilitlenmez.

### 3. Otomatik `wiki/index.md` ve Modül Sayfaları (FR-08)
- **Neden Yapıldı?**  
  Her derlemede `wiki/index.md` (Karpathy Wiki ana haritası) ve `affectsModules` etiketli her dosya yolu için `wiki/modules/<slug>.md` sayfaları otomatik üretilmeye başlandı.

### 4. CLI İyileştirmeleri ve Executable Yetkisi
- `dist/cli/index.js` dosyasına `chmod +x` yetkisi verildi.
- `runlog compile [session]` komutu CLI'a entegre edildi.

- **Nihai Test Durumu:** 6 test dosyasında 26 birim ve entegrasyon testinin tamamı yeşil (`26 passed`).

---

## [2026-11-11] — Canlı Saha Testi (AuraStreamBE) ve Push Cache İyileştirmesi

### 1. AuraStreamBE Canlı Testinden Çıkan Bulgu
- **Ne Oldu?**  
  `AuraStreamBE` projesinde yapılan canlı testte `SuperSecretPass123` şifresi başarıyla maskelendi (`[REDACTED:PASSWORD:51926f]`) ve `runlog compile` ile `RCA-1377.md` çıkarıldı.  
  Ancak sonraki oturumda `runlog hook antigravity pre-invocation` çalıştırıldığında çıktı boş döndü.
- **Kök Neden:**  
  `ActiveContextCacheSchema` ve `formatPushInjection` yalnızca `activeDecisions` ve `recentDeadEnds` içeriyordu; yeni oluşan kritik `RCA` kayıtlarını oturum başına push etmiyordu.
- **Nasıl Çözüldü?**  
  - `ActiveContextCacheSchema` içine `recentRCAs` (son 3 RCA kaydı) eklendi.
  - `wiki/index.md` üreticisine `Root Cause Analyses (RCA)` tablosu eklendi.
  - `README.md` dosyasına **Dual-Agent Design & Zero-Cost Offline Compiler** mimari açıklaması eklendi.

---

## [2026-11-11] — Faz 7: Yerel Eklenti Paketi (Native Plugin Bundle) & Canlı MCP Yazma Araçları

### 1. Tek Komutla Kurulabilir Native Plugin Mimarisi
- **Neden Yapıldı?**  
  Kullanıcıların elle `mcp_config.json` veya `hooks.json` düzenlemek zorunda kalmaması, GitHub üzerinden eklenti olarak kolayca kurabilmesi için.
- **Ne Eklendi?**
  - Antigravity Plugin paketi: `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/AGENTS.md`, `skills/agentrunlog/SKILL.md`.
  - Claude Code Plugin paketi: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`.
  - `runlog install-plugin antigravity` komutu: Eklentiyi doğrudan `~/.gemini/config/plugins/agentrunlog/` altına kurar ve çakışma olmaması için kullanıcının manuel MCP kaydını temizler.

### 2. Canlı MCP Yazma Araçları & Multi-Workspace Desteği (`projectRoot`)
- **Neden Yapıldı?**  
  1. Eklenti global olarak kurulduğunda MCP sunucusunun `cwd` dizini eklenti klasörü oluyor. Tüm MCP araçlarına opsiyonel `projectRoot` parametresi eklenerek birden fazla projede aynı anda kesintisiz çalışması sağlandı.
  2. Geliştirici sohbet sırasında *"Bunu karar olarak kaydet"* dediğinde ajanın anında hafızaya yazabilmesi için `record_decision`, `record_dead_end` ve `record_rca` MCP araçları eklendi.

- **Doğrulama:** 27/27 test yeşil (`27 passed`), Antigravity `lsrpc GetAllPlugins` doğrulamasından geçti.

---

## [2026-11-11] — Sıfır Çaba (Zero-Effort) Otomatik Yakalama ve Derleme İyileştirmesi

### 1. "Kullanıcıya 'Kaydet' Dedirtmeme" Kuralı
- **Neden Yapıldı?**  
  Gerçek bir geliştirme sürecinde geliştirici her karar aldığında "bunu kaydet" demez ve unutur.
- **Ne Değiştirildi?**
  1. `HookRunner`: `pre-invocation`, `post-invocation`, `stop`, `session-end` dahil tüm platform olaylarında `stdin` payload'u otomatik ham günlüğe (`raw/`) yazılacak ve günlük oturum ID'si altında gruplanacak şekilde düzeltildi.
  2. `LLMCompilerClient` (Offline Heuristic): Kullanıcı hiçbir komut vermeden sadece doğal sohbette karar cümlesi kurduğunda (*"Let's use X instead of Y"*, *"X yerine Y kullanalım"* vb.) bunu otomatik `Decision`, aynı komutta 2+ kez ardışık hata alındığında bunu otomatik `DeadEnd` olarak çıkaran akıllı kural motoru eklendi.
  3. `rules/AGENTS.md`: Ajanın kullanıcının "kaydet" demesini beklemeden, otonom şekilde karar/RCA/çıkmaz sokak kaydetmesi zorunlu kılındı.

---

## [2026-11-11] — Faz 8: Mevcut Projeler İçin Başlangıç Tarayıcısı (`CodebaseScanner`)

### 1. Yarıda Başlanan Projelerde Geçmişi Tanıma (`src/compiler/scanner.ts`)
- **Neden Yapıldı?**  
  Bir geliştirici AgentRunlog'u sıfırdan yeni bir projeye değil, aylardır üzerinde çalıştığı yarıda bir projeye (ör. `AuraStream-APP` / `AuraStreamBE`) eklediğinde ajan projenin mevcut mimarisini baştan tanımalıdır.
- **Ne Yapar?**  
  `runlog init` (veya manuel `runlog scan`) çalıştığında:
  1. Manifest dosyalarını (`package.json`, `pyproject.toml`, `pubspec.yaml`, `Cargo.toml`, `go.mod`, `Dockerfile`) tarayıp teknoloji yığınını `Decision` olarak kaydeder.
  2. Kaynak dizinlerini (`src/`, `app/`, `lib/` vb.) analiz edip `wiki/modules/*.md` haritasını kurar.
  3. `git log` geçmişindeki son `fix:` commit'lerini tarihsel `RCA`, son commit'leri `Task` olarak derler.
  4. `README.md` / `CLAUDE.md` dokümanlarından proje özetini (gizli verileri temizleyerek) ekler ve `active_context.json` önbelleğini anında doldurur.

---

## [2026-11-11] — Faz 9: Geçmiş Ajan Konuşmalarını Tarama (`HistoryImporter`)

### 1. 4 Platformun Tamamından Geçmiş Konuşma İçe Aktarıcısı (`src/compiler/history-importer.ts`)
- **Neden Yapıldı?**  
  PRD'de belirtildiği üzere yalnızca kod dosyaları değil, desteklenen 4 platformun tamamında (Antigravity, Claude Code, Codex CLI, Cursor) yapılmış geçmiş konuşmaların da taranması gerekiyordu; böylece proje başından sonuna kadar kesintisiz takip edilebilsin.
- **Ne Yapar?**  
  `runlog init` ve `runlog scan [--alias isim]` çalıştığında:
  1. **Antigravity:** `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`
  2. **Claude Code:** `~/.claude/projects/*/*.jsonl`
  3. **Codex CLI:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  4. **Cursor:** `~/.cursor/projects/*/agent-transcripts/*.jsonl` ve `Cursor/User/workspaceStorage/*/state.vscdb` (Node built-in `node:sqlite` üzerinden zero-dependency okuma)
  kayıtlarını tarar.
  5. Proje klasör adı, `package.json` adı veya `--alias` ile eşleşen oturumları bulur (özyineleme koruması ile kendi iç çağrılarını eler).
  6. Tüm veriyi `Sanitizer` üzerinden maskeleyerek `.agentrunlog/raw/session-import-*.jsonl` olarak kaydeder ve sert 800-token tavanı (NFR-07) ile `wiki/` + `active_context.json` içine derler. Sonraki süreçlerde ise her 4 platformun hook adaptörleri + otonom MCP yazma araçları üzerinden akış baştan sona takip edilir.

---

## [2026-11-11] — Faz 10: Argon Denetim Tahkikatları & 4 Platform Tam Otomasyon Kurulumu (`setup` + `doctor`)

### 1. Argon Mimari Denetiminden Gelen 3 Kritik Güvence
- **3 Kademeli Deterministik Proje Eşleştirme (`history-importer.ts`):**  
  `lowerRaw.includes(projectName)` çapraz bulaşma riskini önlemek için mutlak dosya yolu / klasör sınırı kontrolü, genel kelime kara listesi (`app`, `backend`, `core`, `api` vb.) ve minimum 2+ kez geçme eşiği eklendi.
- **Artımlı Senkronizasyon Önbelleği (`import_state.json`):**  
  Değişmeyen transkriptler `mtimeMs` ve `size` takibiyle 0ms'de atlanır; büyük geçmişlerde bellek/hız kaybı önlendi.
- **NFR-08 Kademeli Güven Süzgeci (`llm-client.ts`, `wiki.ts`):**  
  Geçmiş konuşmalardan LLM'siz regex ile yakalanan tarihsel kayıtlar `status: 'draft'` ve `confidence: 'low'` olarak işaretlendi; `active_context.json` push önbelleğine sızmaları tamamen engellendi.

### 2. Tüm 4 Platform İçin Tam Otomatik Eklenti Kurulumu & Doğrulama (`src/installer/`)
- **Neden Yapıldı?**  
  Kullanıcının tek bir komutla 4 platformun (Antigravity, Claude Code, Cursor, Codex) eklentilerini sorunsuzca kurması ve çalıştığından emin olması için.
- **Eklenen Modüller:**
  - `UniversalPluginInstaller` (`runlog setup`): Mevcut kullanıcı ayarlarını bozmadan (non-destructive merge) tüm platformlara MCP, Hook, Rule ve Skill kurar.
  - `SystemDoctor` (`runlog doctor`): 4 platformun kurulumunu ve canlı stdio MCP handshake testini (8 aracın tümünün yanıt verdiğini) doğrular.

---

## [2026-11-11] — Faz 11: Sıfır Müdahale Tam Otomasyon (`postinstall` + Auto-Bootstrap)

### 1. Kullanıcının Komut Unutması İhtimalini Sıfırlama (`src/compiler/auto-bootstrap.ts`)
- **Neden Yapıldı?**  
  Kullanıcı kurulum sonrası `runlog init` veya `runlog setup` demeyi unutabilir; eklenti bunu kullanıcıya bırakmadan kendi başına halletmelidir.
- **Ne Yapıldı?**
  1. **`postinstall` Otomasyonu (`package.json`):** `npm install -g` çalıştığı anda otomatik olarak `UniversalPluginInstaller.installAll()` tetiklenir ve 4 platform eklentisi kurulur.
  2. **İlk Hook / MCP Çağrısında Otomatik Başlatma (`ensureProjectBootstrapped`):** Kullanıcı herhangi bir projeyi açtığında daha önce `runlog init` çalıştırmamış olsa bile; ilk hook (`bootstrap` detached worker) veya ilk MCP çağrısı projenin geçerli bir yazılım klasörü olduğunu doğrular (`$HOME` veya `/` hariç), `.agentrunlog/` dizinini açar, `.gitignore`'u korur, kod tabanını ve 4 platformun geçmiş sohbetlerini otomatik tarar.
  3. **Çökme Kurtarma (Crash Recovery):** Önceki oturum `Stop`/`SessionEnd` tetiklemeden kapandıysa, sonraki oturum başlangıcında derleyici worker arka planda sessizce eksik verileri derler.











---

## [2026-11-13] — Faz 12: Denetim Düzeltmeleri, Modelsiz Mimari, Otomatik Geçmiş Senkronu

### 1. Denetimden gelen düzeltmeler
- **Antigravity hook formatı:** `hooks.json` artık gerçek biçimde (grup adı → olay listesi); `SessionStart/PreInvocation/PostInvocation/Stop` düz dizi, `PostToolUse` matcher'lı. stdin camelCase (`conversationId`, `workspacePaths`), çıktı `injectSteps` / `decision`. `formatHookOutput` her platformun çıktı lehçesini tek yerde üretir.
- **Push zamanı (R13):** bağlam yalnızca `SessionStart`'ta, bir kez enjekte edilir.
- **MCP (R9):** `record_*` kayıt kimlikleri çakışmaz (`nextRecordId`), girdi sanitizasyondan geçer.
- **Güven (R11/R12):** tarayıcı/geçmişten gelen kararlar `draft`; kararlar ve dead-end'ler yeniden eskiye sıralı. `trustedImport` seçeneği yalnızca geçmiş içe aktarmanın, özyineleme kalkanını (`AGENTRUNLOG_INTERNAL`) aşmasına izin verir.

### 2. Model çağrısı tamamen kaldırıldı
- `llm-client.ts` silindi; `heuristic.ts` (`heuristicExtract`, `normalizeToolPayload`) deterministik, çevrimdışı çıkarım yapar. Provider/model/endpoint ayarları şemadan çıktı. **Ürün yönü:** önemli olan yapılan iş ve kullanıcı ile yazılımın nasıl ilerlediği; model değil.

### 3. Geçmiş içe aktarmada kırpma yok
- İçe aktarılan mesajlar artık hiçbir şekilde kırpılmaz (süreç bütünlüğü). `runlog scan --force` bütün konuşmaları yeniden alır.
- **Orijinal platform kayıtlarına asla dokunulmaz** (yalnızca okunur). Yalnızca AgentRunlog'un kendi kopyası (`.agentrunlog/raw/`) yenilenir ve bu da güvenlidir: eski kopya `.prev` olarak kenara alınır, yeni kopya tam yazılırsa silinir, yarım kalırsa geri konur.

### 4. Kullanıcı komut çalıştırmadan otomatik geçmiş senkronu
- `IMPORT_VERSION` (şu an 2): eski sürümle (kırpılmış) alınmış projeler bir sonraki oturumda bir kez tam metinle yeniden alınır.
- `SessionStart` hook'u `cache/history_sync.json`'a bakar; yoksa, sürüm eskiyse ya da 30 dakikadan eskiyse detached `sync-history` işçisini başlatır (kilitli, artımlı, ardından derleme).

### 5. Olay kaybı yok (hook stdin)
- 8MB üst sınırı kaldırıldı. Akış bitene kadar beklenir; yalnızca ilk bayt 1 sn içinde gelmezse ya da 5 sn sessizlik olursa vazgeçilir. Ayrıştırılamayan yük sessizce atılmaz, `cache/hook-errors.log`'a yazılır. 10MB'lık olayla test edildi.

### 6. Disk kullanımı: `runlog usage`
- `.agentrunlog/` altındaki klasörleri (raw, wiki, cache, …) dosya sayısı ve toplamla gösterir (`src/storage/usage.ts`).

### 7. Oturum yolu özeti (`src/compiler/journey.ts`)
- Her derlenen oturum için modelsiz `wiki/runs/<oturum>.md`: istenenler, değişen dosyalar, çalıştırılan komutlar, **hata → düzeltme çiftleri** (başarısız komut, sonradan geçen aynı komut ve arada düzenlenen dosyalar), çözülmemiş hatalar ve oturumun nasıl bittiği. Tam metin `raw/`'da kalır; özet tur numarasıyla ona işaret eder. `wiki/index.md`'de "Recent Sessions" bölümü.
- Push metnine tek satırlık hatırlatma eklendi: kalıcı bir seçim onaylanırsa `record_decision`, riskli değişiklik öncesi `check_dead_ends` (800 token bütçesine dahil).

### Doğrulama
- `tsc` temiz, 53/53 test. Gerçek platformlarla uçtan uca çalıştırma henüz yapılmadı; Antigravity `SessionStart` çıktı şekli (`systemMessage` nesnesi / `userMessage` metni) doğrulanmadı.

## [2026-11-13] — Faz 13: Gerçek Claude Oturumu Testi ve Kalan Açıkların Kapatılması

- **Gerçek Claude Code oturumu (AgentRunlog reposunda):** hook'lar (session_start, prompt_submit, session_end), push enjeksiyonu, derleme, oturum yolu sayfası, otomatik geçmiş senkronu, MCP `get_active_context` ve `usage` doğrulandı.
- **Geçmiş içe aktarma (IMPORT_VERSION 4):** Claude oturumları artık `cwd` ile projeye eşleştirilir (başka projeye sızma yok); `tool_use`/`tool_result` blokları ayrıştırılır; canlı oturum kimliği kullanılır (konuşma başına tek kayıt kümesi), içe aktarılan olaylar `imported` ile işaretlenir ve `draft` kalır. Eski `import_claude_*` kopyaları yalnızca AgentRunlog'un kendi dizininden temizlenir.
- **MCP bağlantısı:** `.mcp.json` `${CLAUDE_PLUGIN_ROOT:-.}` kullanır; `claude mcp list` Connected.
- **Takılma önlemi:** `mcp` dışındaki CLI komutları bitince açıkça çıkar; `sync-history`/`bootstrap`/`compile` için 15 dk'lık gözcü zamanlayıcı.
- **Eşzamanlı oturumlar ve yaşam döngüsü:** iki oturumdan 40 paralel hook (300KB'lık yükler dahil) olay kaybetmeden/bozmadan yazılır; `pre-compact` ve `session-end` arka planda derleyip oturum sayfasını üretir (test eklendi, 55/55).
- **Açık kalan:** gerçek Antigravity oturumu ve `SessionStart` çıktı şekli.

### Faz 13 ek: Gerçek Claude testi tekrarı
- Gerçek `claude -p` oturumunda başarısız Bash komutu kaydedilmedi: Claude Code başarısız araç çağrıları için `PostToolUse` değil `PostToolUseFailure` gönderiyor. Hook `post-tool-use-failure` olarak eklendi (`claude-code.ts`, installer, `hooks/hooks.json`); `post_tool_use` olarak eşlenir, oturum yolunda ❌ görünür. Yeniden testte olay `error: Exit code 1…` ile kaydedildi. 56/56 test.

### Faz 13 ek 2: Gerçek Claude testinde bulunan üç hata
1. **MCP çift sunucu:** `server.ts` içindeki "doğrudan çalıştırılırsa başlat" koşulu bundle içinde de doğru çıkıyordu; aynı stdio'da ikinci sunucu açılıp her araç çağrısı iki kez çalışıyordu (her `record_decision` iki kayıt). Koşul yalnızca bağımsız `mcp/server.js` girişi için geçerli. Test: bundle üzerinden tek çağrı = tek yanıt, tek kayıt.
2. **Reindex açık kararları taslağa düşürüyordu:** `record_decision` kayıtlarında transkript konumu yok (`live_<ms>` oturum kimliği) ve FR-06 bunları `draft` yapıp push'tan çıkarıyordu. Açıkça MCP ile yazılan kayıtlar artık güvenilir sayılır. Test eklendi.
3. **Sezgisel karar çıkarımı canlı oturumda `active` üretiyordu:** "karar" gibi sözcük içeren herhangi bir komut metni push'a girebiliyordu. Anahtar sözcükle tahmin edilen kararlar artık her zaman `draft`/`low`; açık kararlar `record_decision` ile gelir.
- 58/58 test.

## Faz 13 — ek 3 (PRD denetimi)
- RCA yalnızca çözülmüş (yapısal hata → sonra başarı) olduğunda üretilir; çözümde arada düzenlenen dosyalar listelenir.
- Journey: Read artık komut olarak gösterilmez.
- Claude `Stop` hook'u kaydedildi (asistan yanıtı → agent_response).
- Run kayıtları: test/build/lint komutları `RUN-*` olarak yazılır, index.md'de "Recent Runs" tablosu.
- Güvenlik açığı düzeltildi: tırnaksız `password=değer` redakte edilmiyordu (ENV_SECRET deseni ön ek zorunluydu). Test eklendi.
- Denetim sonuçları: hook gecikmesi p95 ≈ 34ms (hedef 20ms; Node başlangıcı tek başına 22ms), p99 ≈ 35ms (hedef 50ms geçer).
- Bilinen sapma: wiki tamamen silinirse yalnızca MCP ile yazılmış kayıtlar raw'dan türetilemez (reindex yalnızca hook olaylarını yeniden kurar).

## Faz 13 — ek 4 (sapmaların kapatılması)
- NFR-10: MCP kayıtları `raw/mcp-records.jsonl` günlüğüne de yazılır; `reindex` wiki silinmiş olsa bile bunları geri yükler.
- FR-05: `record_dead_end` geçici (503/timeout) ve basit sözdizimi hatalarını reddeder.
- NFR-03: `config.privacy.enabled` / `excludePatterns` (glob) ve `runlog pause|resume` ile kayıt kapatma/hariç tutma.
- Doctor: proje seviyesindeki Claude kurulumunu (`.claude/settings.json`, `.mcp.json`) da tanır.
- NFR-05 p95: hook paketi 9KB; kalan fark Node başlangıcı (22ms) — kod tarafında kazanç yok, sapma olarak kalır.
- `init claude` artık proje `.mcp.json` yazar ve `enabledMcpjsonServers` ile önceden onaylar (taze projede MCP yoktu; gerçek Claude testinde bulundu).
- Gerçek Claude testleri: --resume (aynı oturuma eklenir), 3 eşzamanlı oturum (bozulma yok), /compact (pre_compact yakalandı), alt ajan, redaksiyon (password=...), MCP record_decision/get_active_context.
- Global `setup` artık hook'larda hafif `bundle/hook.mjs` kullanır (önceden ağır dist/cli). Sahte HOME ile doğrulandı.
- `runlog report`: etki raporu (oturum, enjeksiyon, kayıt sayıları, tekrarlayan hatalar, lint).
- Gecikme: `--no-experimental-fetch` denendi ama Node 24'te bayrak kaldırılmış (hata verip hemen çıkıyordu, sahte 13ms ölçümü); geri alındı. Boş Node dosyası bile ~20ms; CJS paketi yalnızca ~4ms kazandırıyor. p95 hedefi Node ile ulaşılamaz.
- Gerçek Claude: 27 turluk --resume oturumu, hiçbir olay kaybolmadı (27 prompt/27 yanıt/27 session_start). Not: `-p` her çağrıda SessionEnd tetiklediğinden 25-tur eşiği gerçek oturumda ayrıca izole edilemedi; eşik simüle hook testleriyle doğrulı.
