export type AggregationInterval = 'year' | 'month';

export interface PeriodContributor {
	author: string;
	commits: number;
	profileUrl?: string;
	email?: string;
}

export interface ContributorSeries {
	name: string;
	total: number;
	values: Array<{ label: string; commits: number }>;
	profileUrl?: string;
}

export interface RepoContributionSummary {
	slug: string;
	repoPath: string;
	description?: string;
	cloneDepth: number | null;
	diskSize: number | null;
	interval: AggregationInterval;
	startDate: string;
	endDate: string;
	periods: Array<{
		label: string;
		start: string;
		end: string;
		contributors: PeriodContributor[];
	}>;
	series: ContributorSeries[];
}
