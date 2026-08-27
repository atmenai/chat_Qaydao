# QAYDAO 2026-06-09 — Resolution guard for Captain auto-resolve.
#
# ROOT BUG (conv old-moon-924 / #2806, #1549, #1261):
#   Captain::InboxPendingConversationsResolutionJob auto-resolves any conversation
#   still in 'pending' (bot-owned) status and idle > 1h. In 'evaluated' mode an LLM
#   (Captain::ConversationCompletionService) decides resolve-vs-handoff and sometimes
#   WRONGLY resolves a conversation where the customer explicitly asked for a human
#   (or the bot already promised "وجّهت رسالتك لفريق خدمة العملاء").
#
# DETERMINISTIC GUARANTEE (independent of the LLM):
#   Never auto-RESOLVE a conversation that:
#     * already has a human assignee            -> skip (leave for the agent), OR
#     * carries the escalation label 'تصعيد', OR
#     * contains a human-handoff signal (bot transfer phrase OR explicit customer
#       request for a human) -> hand off (bot_handoff! => :open + escalate) instead.
#
# ---------------------------------------------------------------------------
# QAYDAO 2026-08-27 — NO-AUTOCLOSE FLOW (approved by Rami: "اعتمد").
#   Team complaint (convs #7863 #7864 #7825): the bot silently closed real
#   purchase-intent leads exactly 1 hour after the last message, before customer
#   service could follow up. Measured: 324 auto-closes / 7 days (~46/day), of
#   which 38 needed a human reply AFTER the close and 41 customers came back on
#   their own (~24% premature closes).
#
#   New behaviour for the time-based path (account mode = 'legacy'):
#     stage 1 (idle > 1h, first time)  -> send ONE closing-check message
#                                         ("هل تحتاج أي مساعدة إضافية؟ ... وإن لم
#                                          يصلني رد سأحوّل محادثتك للفريق")
#                                         window 09:00-21:00 Riyadh only.
#                                         NO resolve, NO handoff.
#     stage 2 (idle > 3h, check sent)  -> purchase intent? => bot_handoff! (open,
#                                         unassigned, team decides the close)
#                                         otherwise                => resolve as before.
#
#   Purchase-intent filter = STRICT tier (dry-run: 110/324 = 34% -> ~16/day into
#   the team queue, vs 257 = 79% for the wide tier). Post-purchase tracking words
#   ('الطلب', 'توصيل') and generic bot product links are deliberately EXCLUDED —
#   the bot answers those with the tracking/catalog tools.
#
#   Conversations with zero incoming customer messages (outbound campaigns) keep
#   the old behaviour: straight resolve, never a check message.
#
# Idempotent. fail-SAFE: on any error we SKIP resolving (never wrongly close).
# Bind-mounted on web + sidekiq; survives restarts/upgrades.

Rails.application.config.to_prepare do
  next unless defined?(Captain::InboxPendingConversationsResolutionJob)

  klass = Captain::InboxPendingConversationsResolutionJob
  unless klass.included_modules.map(&:name).include?('QaydaoResolutionGuard')
    mod = Module.new do
      def self.name = 'QaydaoResolutionGuard'

      QAYDAO_ESCALATION_LABEL = 'تصعيد'
      QAYDAO_HUMAN_SIGNAL_PATTERNS = [
        # bot transfer phrases (soft handoff)
        'لفريق خدمة العملاء', 'ممثلي خدمة العملاء', 'رفع طلبك لخدمة العملاء',
        'لدى خدمة العملاء', 'وجّهت رسالتك', 'وجهت رسالتك', 'تم توجيه رسالتك',
        'سيتواصل معك فريق', 'سيتواصلون معك',
        # explicit customer requests for a human
        'اتواصل مع', 'أتواصل مع', 'ابغى اكلم', 'أبغى أكلم', 'ابي اكلم', 'أبي أكلم',
        'كلموني', 'حولني', 'حوّلني', 'حولوني', 'موظف', 'ممثل', 'مندوب',
        'شخص يفيدني', 'احد يساعدني', 'أحد يساعدني', 'بشري'
      ].freeze

      # --- 2026-08-27 no-autoclose flow constants -----------------------------
      QAYDAO_CHECK_ATTR       = 'qaydao_closing_check_at'.freeze
      QAYDAO_DECISION_IDLE    = 3.hours
      QAYDAO_SEND_HOUR_START  = 9   # Riyadh
      QAYDAO_SEND_HOUR_END    = 21  # Riyadh (exclusive)
      QAYDAO_RIYADH_OFFSET    = 3.hours

      QAYDAO_CHECK_MESSAGE = <<~MSG.strip
        هل تحتاج أي مساعدة إضافية؟ 🌿
        إن رغبت بمتابعة من فريق خدمة العملاء أخبرني وسأحوّلك مباشرة — وإن لم يصلني رد سأحوّل محادثتك للفريق ليتابعوا معك.
      MSG

      QAYDAO_HANDOFF_MESSAGE = <<~MSG.strip
        تم تحويل محادثتك لفريق خدمة العملاء لمتابعتها معك 🌿
        أوقات العمل: من السبت إلى الخميس، من ٩ صباحاً حتى ٨ مساءً. وإن كانت رسالتك خارج هذه الأوقات فسيصلك الرد مع بداية الدوام في تمام ٩ صباحاً.
      MSG

      # STRICT purchase-intent tier (approved 2026-08-27).
      QAYDAO_INTENT_REGEX = /(سعر|الاسعار|الأسعار|بكم|كم سعر|خصم|كوبون|تقسيط|تابي|تمارا|متوفر|متوفرة|موجود|موجودة|مقاس|مقاسات|تفصيل|ابغى|أبغى|ابي |أبي |اطلب|أطلب|فرع|معرض|موقعكم|موقعكم وين|وين|واتس)/

      # Evaluated mode (active config) routes every close through resolve_conversation.
      def resolve_conversation(conversation, inbox, reason)
        if conversation.assignee_id.present?
          Rails.logger.info("[qaydao-resolve-guard] conv ##{conversation.id} has human assignee -> skip auto-resolve")
          return
        end
        if qaydao_conversation_needs_human?(conversation)
          Rails.logger.info("[qaydao-resolve-guard] conv ##{conversation.id} human-handoff signal -> handoff instead of resolve")
          handoff_conversation(conversation, inbox, reason)
          return
        end
        super
      rescue StandardError => e
        Rails.logger.warn("[qaydao-resolve-guard] conv ##{conversation&.id} guard error -> SKIP resolve (fail-safe): #{e.message}")
        nil
      end

      # -----------------------------------------------------------------------
      # Time-based path (active mode = 'legacy'). Rewritten 2026-08-27.
      # -----------------------------------------------------------------------
      def perform_time_based(inbox)
        Current.executed_by = inbox.captain_assistant
        resolvable_pending_conversations(inbox).each do |conversation|
          qaydao_process_idle_conversation(conversation, inbox)
        end
      rescue StandardError => e
        Rails.logger.warn("[qaydao-resolve-guard] time-based guard error: #{e.message}")
      end

      def qaydao_process_idle_conversation(conversation, inbox)
        # 1) already needs a human -> hand off, never close.
        if conversation.assignee_id.present? || qaydao_conversation_needs_human?(conversation)
          Rails.logger.info("[qaydao-noautoclose] conv ##{conversation.id} needs human -> handoff")
          qaydao_handoff(conversation, inbox, 'human handoff signal detected')
          return
        end

        # 2) outbound / campaign conversations (no customer message at all) keep old behaviour.
        unless qaydao_customer_messages(conversation).exists?
          create_resolution_message(conversation, inbox)
          conversation.resolved!
          return
        end

        checked_at = qaydao_check_sent_at(conversation)

        # 3) stage 1 — send the closing-check message once, inside the send window.
        if checked_at.nil?
          unless qaydao_inside_send_window?
            Rails.logger.info("[qaydao-noautoclose] conv ##{conversation.id} outside send window -> wait")
            return
          end
          qaydao_send_check_message(conversation, inbox)
          return
        end

        # 4) stage 2 — decide only after the longer idle window.
        return if conversation.last_activity_at.present? && conversation.last_activity_at > (Time.now.utc - QAYDAO_DECISION_IDLE)

        # 2026-08-27 (Rami: "اعتمد الخيار 1") — ZERO auto-close. Any conversation
        # that had at least one customer message is handed to the team; only a
        # human agent may close it. Triggered by conv #4591: an answered order
        # tracking chat was still auto-resolved, which the CS team rejects.
        reason = qaydao_purchase_intent?(conversation) ? 'purchase intent' : 'no reply to closing check'
        Rails.logger.info("[qaydao-noautoclose] conv ##{conversation.id} -> handoff to team (#{reason})")
        qaydao_handoff(conversation, inbox, "#{reason}; closing decision belongs to CS")
      rescue StandardError => e
        Rails.logger.warn("[qaydao-noautoclose] conv ##{conversation&.id} error -> SKIP (fail-safe): #{e.message}")
        nil
      end

      def qaydao_customer_messages(conversation)
        conversation.messages.where(message_type: :incoming, private: false)
      end

      def qaydao_check_sent_at(conversation)
        raw = conversation.custom_attributes.is_a?(Hash) ? conversation.custom_attributes[QAYDAO_CHECK_ATTR] : nil
        raw.present? ? Time.zone.parse(raw.to_s) : nil
      rescue StandardError
        nil
      end

      def qaydao_inside_send_window?
        hour = (Time.now.utc + QAYDAO_RIYADH_OFFSET).hour
        hour >= QAYDAO_SEND_HOUR_START && hour < QAYDAO_SEND_HOUR_END
      end

      def qaydao_send_check_message(conversation, inbox)
        begin
          conversation.messages.create!(
            message_type: :outgoing,
            private: false,
            sender: inbox.captain_assistant,
            account_id: conversation.account_id,
            inbox_id: conversation.inbox_id,
            content: QAYDAO_CHECK_MESSAGE,
            preserve_waiting_since: true
          )
          Rails.logger.info("[qaydao-noautoclose] conv ##{conversation.id} closing-check message sent")
        rescue StandardError => e
          # e.g. WhatsApp 24h window closed. Mark it anyway so we don't retry forever.
          Rails.logger.warn("[qaydao-noautoclose] conv ##{conversation.id} check message failed: #{e.message}")
        end
        conversation.update_columns(
          custom_attributes: (conversation.custom_attributes || {}).merge(QAYDAO_CHECK_ATTR => Time.now.utc.iso8601)
        )
      end

      def qaydao_handoff(conversation, inbox, reason)
        create_private_note(conversation, inbox, "Auto-handoff: #{reason}")
        begin
          conversation.messages.create!(
            message_type: :outgoing,
            private: false,
            sender: inbox.captain_assistant,
            account_id: conversation.account_id,
            inbox_id: conversation.inbox_id,
            content: QAYDAO_HANDOFF_MESSAGE,
            preserve_waiting_since: true
          )
        rescue StandardError => e
          Rails.logger.warn("[qaydao-noautoclose] conv ##{conversation.id} handoff message failed: #{e.message}")
        end
        conversation.bot_handoff!
      rescue StandardError => e
        Rails.logger.warn("[qaydao-noautoclose] conv ##{conversation&.id} handoff failed: #{e.message}")
      end

      def qaydao_purchase_intent?(conversation)
        # any unanswered customer question (last non-activity message is incoming)
        last = conversation.messages
                           .where(message_type: [0, 1], private: false)
                           .reorder(id: :desc).first
        return true if last.present? && last.message_type == 'incoming' && !last.content.to_s.start_with?('هل تحتاج أي مساعدة إضافية')

        text = qaydao_customer_messages(conversation).pluck(:content).compact.join(' ')
        text.match?(QAYDAO_INTENT_REGEX)
      rescue StandardError => e
        Rails.logger.warn("[qaydao-noautoclose] intent check failed conv ##{conversation&.id}: #{e.message} — treating as intent (fail-safe)")
        true
      end

      def qaydao_conversation_needs_human?(conversation)
        return true if conversation.label_list.include?(QAYDAO_ESCALATION_LABEL)

        likes = QAYDAO_HUMAN_SIGNAL_PATTERNS.map { |p| "%#{p}%" }
        conversation.messages.where('content ILIKE ANY (ARRAY[?])', likes).exists?
      rescue StandardError => e
        Rails.logger.warn("[qaydao-resolve-guard] needs_human? error conv ##{conversation&.id}: #{e.message}")
        true # fail-safe: when unsure, treat as needing a human (never wrongly resolve)
      end
    end

    klass.prepend(mod)
    Rails.logger.info('[qaydao-patch] captain resolution-guard applied (no auto-close: check message -> handoff or resolve)')
  end

  # ---------------------------------------------------------------------------
  # QAYDAO 2026-06-10 (Fix D) — MODEL-LEVEL RESOLUTION LOCK after handoff.
  #
  # Bug pattern (conv #2831 / old-moon-924): conversation correctly handed off
  # (assigned + urgent), then 12s later resolved via the WIDGET path attributed
  # to the customer + CSAT fired — agent never got to reply.
  #
  # Rule: a conversation carrying the escalation label 'تصعيد' can ONLY be
  # resolved by a human agent (Current.user is a User), or by anyone AFTER a
  # human agent has actually replied (post-escalation). Covers ALL paths:
  # widget toggle_status, bot resolved!, API — because it sits on the model.
  # Fail-open on errors (never block agents due to a guard bug).
  # ---------------------------------------------------------------------------
  if defined?(Conversation) && !Conversation.included_modules.map(&:name).include?('QaydaoResolutionLock')
    lock = Module.new do
      def self.name = 'QaydaoResolutionLock'

      QAYDAO_LOCK_LABEL = 'تصعيد'

      def toggle_status
        # toggle resolves only FROM open (open -> resolved); pending -> open must stay allowed
        if open? && qaydao_resolution_locked?
          Rails.logger.info("[qaydao-resolution-lock] blocked toggle_status->resolved on conv ##{id} (escalated, awaiting agent reply)")
          return false
        end
        super
      end

      def resolved!(*args)
        if qaydao_resolution_locked?
          Rails.logger.info("[qaydao-resolution-lock] blocked resolved! on conv ##{id} (escalated, awaiting agent reply)")
          return false
        end
        super
      end

      def qaydao_resolution_locked?
        return false if Current.user.is_a?(::User) # human agent action — always allowed
        return false unless label_list.include?(QAYDAO_LOCK_LABEL)

        escalated_at = ActsAsTaggableOn::Tagging
                         .joins(:tag)
                         .where(taggable_type: 'Conversation', taggable_id: id, context: 'labels')
                         .where(tags: { name: QAYDAO_LOCK_LABEL })
                         .minimum(:created_at)
        return false if escalated_at.nil?

        agent_replied = messages
                          .where(message_type: :outgoing, sender_type: 'User', private: false)
                          .where('messages.created_at >= ?', escalated_at)
                          .where("NOT (additional_attributes ? 'template_params')")
                          .exists?
        !agent_replied
      rescue StandardError => e
        Rails.logger.warn("[qaydao-resolution-lock] check failed conv ##{id}: #{e.message} — allowing (fail-open)")
        false
      end
    end

    Conversation.prepend(lock)
    Rails.logger.info('[qaydao-patch] conversation resolution-lock applied (escalated convs close only by/after a human agent)')
  end
end
