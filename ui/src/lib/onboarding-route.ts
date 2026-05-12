type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

function selectExistingCompanyId(params: {
  companies: OnboardingRouteCompany[];
  selectedCompanyId?: string | null;
}): string | null {
  const { companies, selectedCompanyId } = params;
  if (companies.length === 0) return null;
  if (selectedCompanyId && companies.some((company) => company.id === selectedCompanyId)) {
    return selectedCompanyId;
  }
  return companies[0]?.id ?? null;
}

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    return segments[0]?.toLowerCase() === "onboarding";
  }

  if (segments.length === 2) {
    return segments[1]?.toLowerCase() === "onboarding";
  }

  return false;
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
  selectedCompanyId?: string | null;
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companyPrefix, companies, selectedCompanyId } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!companyPrefix) {
    const existingCompanyId = selectExistingCompanyId({ companies, selectedCompanyId });
    if (existingCompanyId) {
      return { initialStep: 2, companyId: existingCompanyId };
    }
    return { initialStep: 1 };
  }

  const matchedCompany =
    companies.find(
      (company) =>
        company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedCompany) {
    const existingCompanyId = selectExistingCompanyId({ companies, selectedCompanyId });
    if (existingCompanyId) {
      return { initialStep: 2, companyId: existingCompanyId };
    }
    return { initialStep: 1 };
  }

  return { initialStep: 2, companyId: matchedCompany.id };
}

export function shouldRedirectCompanylessRouteToOnboarding(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return !params.hasCompanies && !isOnboardingPath(params.pathname);
}
