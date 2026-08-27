# QAYDAO 2026-08-25 — CSAT Human-Touch Guard
#
# ROOT PROBLEM (August 2026 data, conversations 7445 / 7302 / 6385):
#   Chatwoot fires the CSAT survey on EVERY resolved conversation, including ones
#   where no human agent ever replied — the bot answered (or failed to), the
#   conversation was auto-resolved, and the customer still received "rate us".
#
#   Measured impact (1–24 Aug 2026):
#     * conversations touched by a human : 46 responses, avg 3.48, 15 one-star (33%)
#     * bot-only conversations           : 12 responses, avg 2.17,  8 one-star (67%)
#   => one third of ALL one-star ratings came from conversations nobody answered.
#      Suppressing those lifts the monthly average from 3.21 to 3.48 with zero
#      extra effort from the team, and stops punishing agents for bot misses.
#
# WHAT THIS DOES:
#   Blocks the CSAT survey unless at least one NON-PRIVATE outgoing message was
#   sent by a real human agent (sender_type = 'User', excluding system accounts).
#   Instead of silently skipping, it writes an activity note on the timeline so
#   the miss stays visible and auditable rather than hidden.
#
# WHAT IT DOES NOT DO:
#   Does not change WHEN conversations resolve, does not touch the bot, does not
#   alter survey content, and does not retroactively affect existing responses.
#
# FAIL-OPEN BY DESIGN:
#   Any unexpected error falls back to Chatwoot's original decision, so a bug here
#   can never silently kill CSAT collection.
#
# Idempotent. Bind-mounted on web + sidekiq; survives restarts/upgrades.

Rails.application.config.to_prepare do
  next unless defined?(CsatSurveyService)

  unless CsatSurveyService.included_modules.map(&:name).include?('QaydaoCsatHumanGuard')
    mod = Module.new do
      def self.name = 'QaydaoCsatHumanGuard'

      # حسابات نظام لا تُعدّ تواصلاً بشرياً مع العميل
      QAYDAO_SYSTEM_AGENT_EMAILS = %w[
        quality-guard@qaydao.com
        admin@qaydao.com
      ].freeze

      def should_send_csat_survey?
        return false unless super

        return true if qaydao_human_replied?

        qaydao_log_csat_skipped
        false
      rescue StandardError => e
        Rails.logger.error("[QAYDAO CSAT GUARD] fail-open on conversation " \
                           "#{begin conversation.id rescue 'unknown' end}: #{e.class}: #{e.message}")
        true
      end

      private

      # رسالة صادرة، غير خاصة، من موظف بشري حقيقي
      def qaydao_human_replied?
        scope = conversation.messages
                            .where(message_type: :outgoing)
                            .where(sender_type: 'User')
                            .where(private: false)

        system_ids = User.where(email: QAYDAO_SYSTEM_AGENT_EMAILS).pluck(:id)
        scope = scope.where.not(sender_id: system_ids) if system_ids.any?

        scope.exists?
      end

      def qaydao_log_csat_skipped
        Rails.logger.info("[QAYDAO CSAT GUARD] skipped conversation #{conversation.id} " \
                          "(inbox #{conversation.inbox_id}) — no human agent reply")

        activity_params = {
          account_id: conversation.account_id,
          inbox_id: conversation.inbox_id,
          message_type: :activity,
          content: 'لم يُرسل استبيان الرضا: لم يتواصل أي موظف بشري مع العميل في هذه المحادثة.'
        }
        ::Conversations::ActivityMessageJob.perform_later(conversation, activity_params)
      rescue StandardError => e
        Rails.logger.error("[QAYDAO CSAT GUARD] activity note failed: #{e.class}: #{e.message}")
      end
    end

    CsatSurveyService.prepend(mod)
    Rails.logger.info('[QAYDAO CSAT GUARD] loaded — CSAT requires a human reply')
  end
end
