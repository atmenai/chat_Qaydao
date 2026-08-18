# QAYDAO — Captain (QAYDAO AI) enhancements. Two independent, fail-OPEN patches:
#
#  (1) AI SIGNATURE: append a fixed Arabic line to EVERY outgoing reply produced
#      by QAYDAO AI (Captain) so customers know it's an automated AI reply.
#      - Applied ONLY to Captain-generated outgoing messages (this Job's sender
#        is the assistant), so human-agent replies and private notes are never touched.
#      - Idempotent: never appended twice within the same message.
#
#  (2) SMART REPLY SUGGESTIONS: upgrade the agent-facing "suggest reply" so it
#      returns 3 high-quality, context-aware options (brief / detailed /
#      ask-for-missing-info-or-escalate) grounded in the latest customer messages,
#      order data when present, and QAYDAO policies — instead of one generic line.
#
# Both are monkey-patches loaded as a Rails initializer (same pattern as the
# existing qaydao_captain_no_interrupt.rb). Any error -> original behavior.

# ---- shared constant ---------------------------------------------------------
QAYDAO_AI_SIGNATURE = "\u2014 \u0631\u062f \u0622\u0644\u064a \u0628\u0648\u0627\u0633\u0637\u0629 \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a \u0645\u0646 QAYDAO AI".freeze
# = "— رد آلي بواسطة الذكاء الاصطناعي من QAYDAO AI"

module QaydaoAiSignature
  module_function

  # True if the signature is already present (avoid double-append).
  def present_in?(text)
    text.to_s.include?("QAYDAO AI") &&
      text.to_s.include?("\u0631\u062f \u0622\u0644\u064a") # "رد آلي"
  end

  def append(text)
    body = text.to_s
    return body if body.strip.empty?
    return body if present_in?(body)
    "#{body}\n\n#{QAYDAO_AI_SIGNATURE}"
  end
end

if defined?(Rails) && Rails.respond_to?(:application)
  Rails.application.config.to_prepare do
    # === (1) SIGNATURE on Captain outgoing replies ===========================
    if defined?(Captain::Conversation::ResponseBuilderJob) &&
       !Captain::Conversation::ResponseBuilderJob.included_modules.map(&:name).include?('QaydaoAiSignaturePatch')
      sig_mod = Module.new do
        def self.name = 'QaydaoAiSignaturePatch'

        # create_messages builds the actual AI reply (not the handoff). We wrap
        # the response content right before the message is created.
        def create_messages
          begin
            if @response.is_a?(Hash) && @response['response'].is_a?(String) && @response['response'].present?
              @response = @response.dup
              @response['response'] = QaydaoAiSignature.append(@response['response'])
            end
          rescue StandardError => e
            Rails.logger.warn("[QAYDAO][AiSignature] skipped: #{e.class}: #{e.message}")
          end
          super
        end
      end
      Captain::Conversation::ResponseBuilderJob.prepend(sig_mod)
      Rails.logger.info('[QAYDAO][AiSignature] ResponseBuilderJob patched')
    end

    # === (2) SMART 3-OPTION REPLY SUGGESTIONS ================================
    if defined?(Captain::ReplySuggestionService) &&
       !Captain::ReplySuggestionService.included_modules.map(&:name).include?('QaydaoSmartReplySuggestions')
      sug_mod = Module.new do
        def self.name = 'QaydaoSmartReplySuggestions'

        # Override the system prompt to demand three context-aware options.
        # Keeps the original prompt as the base (channel/signature/search-tool
        # handling) and appends QAYDAO's structured-output contract.
        def system_prompt
          base = super
          extra = <<~AR_PROMPT.freeze

            ====================  \u062a\u0639\u0644\u064a\u0645\u0627\u062a QAYDAO \u0644\u0644\u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a  ====================
            \u0623\u0646\u062a \u062a\u0633\u0627\u0639\u062f \u0645\u0648\u0638\u0641 \u062e\u062f\u0645\u0629 \u0639\u0645\u0644\u0627\u0621 \u0641\u064a \u0645\u062a\u062c\u0631 QAYDAO (\u0643\u0648\u0627\u064a \u062f\u0627\u0648). \u0627\u0628\u0646\u0650 \u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a\u0643 \u0641\u0639\u0644\u064a\u0627\u064b \u0639\u0644\u0649:
            - \u0622\u062e\u0631 \u0631\u0633\u0627\u0626\u0644 \u0627\u0644\u0639\u0645\u064a\u0644 \u0648\u0645\u0627 \u064a\u0637\u0644\u0628\u0647 \u062a\u062d\u062f\u064a\u062f\u0627\u064b.
            - \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0637\u0644\u0628 \u0625\u0646 \u0648\u064f\u062c\u062f\u062a \u0641\u064a \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 (\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628\u060c \u0627\u0644\u062d\u0627\u0644\u0629\u060c \u0627\u0644\u0645\u0646\u062a\u062c\u060c \u0627\u0644\u0634\u062d\u0646).
            - \u0633\u064a\u0627\u0633\u0627\u062a QAYDAO \u0648\u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0641\u0642\u0637 (\u0644\u0627 \u062a\u062e\u062a\u0631\u0639 \u0623\u0633\u0639\u0627\u0631\u0627\u064b \u0623\u0648 \u0633\u064a\u0627\u0633\u0627\u062a \u0623\u0648 \u0631\u0648\u0627\u0628\u0637 \u063a\u064a\u0631 \u0645\u0630\u0643\u0648\u0631\u0629).

            \u0623\u062e\u0631\u062c \u062b\u0644\u0627\u062b\u0629 \u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a \u0628\u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u0628\u0627\u0644\u0635\u064a\u063a\u0629 \u0627\u0644\u062a\u0627\u0644\u064a\u0629 \u062d\u0631\u0641\u064a\u0627\u064b (\u0628\u0644\u0627 \u0623\u064a \u0645\u0642\u062f\u0645\u0627\u062a):

            \u3010\u0631\u062f \u0645\u062e\u062a\u0635\u0631\u3011
            <\u0631\u062f \u0642\u0635\u064a\u0631 \u0645\u0628\u0627\u0634\u0631 \u064a\u0639\u0627\u0644\u062c \u0637\u0644\u0628 \u0627\u0644\u0639\u0645\u064a\u0644 \u0641\u064a \u062c\u0645\u0644\u0629 \u0623\u0648 \u062c\u0645\u0644\u062a\u064a\u0646>

            \u3010\u0631\u062f \u062a\u0641\u0635\u064a\u0644\u064a\u3011
            <\u0631\u062f \u0623\u0648\u0641\u0649 \u064a\u0634\u0631\u062d \u0627\u0644\u062e\u0637\u0648\u0627\u062a \u0623\u0648 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0628\u0648\u0636\u0648\u062d \u0648\u0627\u062d\u062a\u0631\u0627\u0641>

            \u3010\u0637\u0644\u0628 \u0645\u0639\u0644\u0648\u0645\u0627\u062a / \u062a\u0635\u0639\u064a\u062f\u3011
            <\u0625\u0630\u0627 \u0643\u0627\u0646\u062a \u0647\u0646\u0627\u0643 \u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0646\u0627\u0642\u0635\u0629 \u0627\u0637\u0644\u0628\u0647\u0627 \u0628\u0623\u062f\u0628\u061b \u0648\u0625\u0646 \u0643\u0627\u0646\u062a \u0627\u0644\u062d\u0627\u0644\u0629 \u062a\u062d\u062a\u0627\u062c \u062a\u062f\u062e\u0644\u0627\u064b \u0628\u0634\u0631\u064a\u0627\u064b \u0627\u0642\u062a\u0631\u062d \u062a\u0635\u0639\u064a\u062f\u0627\u064b \u0644\u0644\u0645\u0648\u0638\u0641 \u0627\u0644\u0645\u062e\u062a\u0635 \u0645\u0639 \u0633\u0628\u0628 \u0627\u0644\u062a\u0635\u0639\u064a\u062f>

            \u0642\u0648\u0627\u0639\u062f \u0625\u0644\u0632\u0627\u0645\u064a\u0629:
            - \u0627\u062c\u0639\u0644 \u0643\u0644 \u0627\u0642\u062a\u0631\u0627\u062d \u0645\u062e\u062a\u0644\u0641\u0627\u064b \u0641\u0639\u0644\u0627\u064b \u0648\u0645\u0641\u064a\u062f\u0627\u064b\u061b \u0645\u0645\u0646\u0648\u0639 \u0627\u0644\u0631\u062f\u0648\u062f \u0627\u0644\u0639\u0627\u0645\u0629 \u0645\u062b\u0644 \u00ab\u0643\u064a\u0641 \u0623\u0633\u0627\u0639\u062f\u0643\u061f\u00bb \u0623\u0648 \u00ab\u0633\u0623\u062a\u062d\u0642\u0642 \u0648\u0623\u0639\u0648\u062f \u0625\u0644\u064a\u0643\u00bb \u0628\u0644\u0627 \u0645\u0636\u0645\u0648\u0646.
            - \u0625\u0646 \u0644\u0645 \u062a\u062a\u0648\u0641\u0631 \u0645\u0639\u0644\u0648\u0645\u0629 \u0643\u0627\u0641\u064a\u0629\u060c \u0648\u0636\u0651\u062d \u0630\u0644\u0643 \u0641\u064a \u0627\u0644\u0627\u0642\u062a\u0631\u0627\u062d \u0627\u0644\u062b\u0627\u0644\u062b \u0628\u062f\u0644 \u0627\u0644\u062a\u062e\u0645\u064a\u0646.
            - \u0628\u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u062f\u0627\u0626\u0645\u0627\u064b\u060c \u0628\u0644\u0647\u062c\u0629 \u0645\u0647\u0646\u064a\u0629 \u0648\u062f\u0648\u062f\u0629 \u062a\u0646\u0627\u0633\u0628 \u062e\u062f\u0645\u0629 \u0639\u0645\u0644\u0627\u0621 QAYDAO.
            ==========================================================================
          AR_PROMPT
          "#{base}\n#{extra}"
        end
      end
      Captain::ReplySuggestionService.prepend(sug_mod)
      Rails.logger.info('[QAYDAO][SmartReplySuggestions] ReplySuggestionService patched')
    end
  end
end
