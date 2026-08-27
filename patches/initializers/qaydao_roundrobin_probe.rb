# QAYDAO probe 2026-08-27 — diagnostic only, NO behaviour change.
#
# Why: agents that switch back from "busy" to "online" sometimes keep losing
# every round-robin pick to the same colleague. Suspected cause is the queue in
# Redis drifting out of sync with inbox members, which makes
# InboxRoundRobinService#available_agent call reset_queue on every invocation and
# turn the pick deterministic (always the lowest user_id among online agents).
#
# This wraps available_agent and records queue state before/after each pick into a
# capped Redis list. It never alters the returned agent. Fail-open everywhere.
#
# Read with:
#   redis-cli lrange alfred:QAYDAO_RR_PROBE 0 50
# Remove by deleting the compose mount line and recreating chatwoot_sidekiq.

Rails.application.config.to_prepare do
  module QaydaoRoundRobinProbe
    PROBE_KEY   = 'QAYDAO_RR_PROBE'.freeze
    MAX_ENTRIES = 5000

    def available_agent(allowed_agent_ids: [])
      queue_before = probe_queue
      queue_valid  = probe_valid?(queue_before)

      result = super

      probe_record(allowed_agent_ids, queue_before, queue_valid, probe_queue, result)
      result
    end

    private

    def probe_queue
      ::Redis::Alfred.lrange(format(::Redis::Alfred::ROUND_ROBIN_AGENTS, inbox_id: inbox.id))
    rescue StandardError
      nil
    end

    def probe_valid?(queue_before)
      return nil if queue_before.nil?

      inbox.inbox_members.map(&:user_id).sort == queue_before.map(&:to_i).sort
    rescue StandardError
      nil
    end

    def probe_record(allowed, queue_before, queue_valid, queue_after, result)
      payload = {
        t: Time.zone.now.iso8601,
        inbox: inbox.id,
        allowed: Array(allowed),
        valid: queue_valid,
        q_before: queue_before,
        q_after: queue_after,
        picked: result.respond_to?(:id) ? result.id : nil
      }.to_json

      ::Redis::Alfred.lpush(PROBE_KEY, payload)
      $alfred.with { |conn| conn.ltrim(PROBE_KEY, 0, MAX_ENTRIES - 1) }
    rescue StandardError => e
      Rails.logger.warn "[QAYDAO RR PROBE] skipped: #{e.class}: #{e.message}"
    end
  end

  AutoAssignment::InboxRoundRobinService.prepend(QaydaoRoundRobinProbe)
end
