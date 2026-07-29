class V2::Reports::Timeseries::AverageReportBuilder < V2::Reports::Timeseries::BaseTimeseriesBuilder
  def timeseries
    grouped_average_time = reporting_events.average(average_value_key)
    grouped_event_count = reporting_events.count
    grouped_average_time.each_with_object([]) do |element, arr|
      event_date, average_time = element
      arr << {
        value: average_time,
        timestamp: event_date.in_time_zone(timezone).to_i,
        count: grouped_event_count[event_date]
      }
    end
  end

  # QAYDAO patch 2026-07-29 — the SUMMARY card reports the MEDIAN, not the mean.
  #
  # Why: the mean is dominated by a few conversations the Captain bot answered
  # in ~3 seconds but no human touched for weeks. For 23-29 Jul 2026, 16 of 238
  # first_response events carried 84.4% of the total, so the card printed
  # "17h 59m" while the median was 2.6 minutes. Both are true; the mean is the
  # one that misleads a monthly performance review.
  #
  # Scope: aggregate_value only (the big summary card). #timeseries above — the
  # per-day bars — is untouched upstream code and still averages.
  #
  # Upstream: app/builders/v2/reports/timeseries/average_report_builder.rb
  # chatwoot v4.13.0, md5 4682dd2d89e8c7b374861e39145251ce — re-diff on any version bump.
  def aggregate_value
    object_scope.unscope(:order)
                .pick(Arel.sql("percentile_cont(0.5) WITHIN GROUP (ORDER BY #{average_value_key})"))
  end

  private

  def event_name
    metric_to_event_name = {
      avg_first_response_time: :first_response,
      avg_resolution_time: :conversation_resolved,
      reply_time: :reply_time
    }
    metric_to_event_name[params[:metric].to_sym]
  end

  def object_scope
    scope.reporting_events.where(name: event_name, created_at: range, account_id: account.id)
  end

  def reporting_events
    @grouped_values = object_scope.group_by_period(
      group_by,
      :created_at,
      default_value: 0,
      range: range,
      permit: %w[day week month year hour],
      time_zone: timezone
    )
  end

  def average_value_key
    @average_value_key ||= params[:business_hours].present? ? :value_in_business_hours : :value
  end
end
