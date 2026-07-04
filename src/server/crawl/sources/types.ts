export type SearchCriteria = {
  city: string;
  // Craigslist's own sub-area path segment (e.g. "brk" for Brooklyn within
  // newyork.craigslist.org, "sfc" for San Francisco within sfbay.craigslist.org).
  // Scoping to a sub-area narrows Craigslist's own recency-capped result
  // window to just that area instead of the whole (often huge) metro.
  subarea?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
};

export type RawListing = {
  externalId: string;
  url: string;
  title: string;
  price: number | null;
  locationText: string | null;
  city: string;
};

export type ListingDetails = {
  bedrooms: number | null;
  bathrooms: number | null;
  postedAt: Date | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

export interface ListingSource {
  search(criteria: SearchCriteria): Promise<RawListing[]>;
  fetchDetails(url: string): Promise<ListingDetails>;
}
