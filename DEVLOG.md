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


