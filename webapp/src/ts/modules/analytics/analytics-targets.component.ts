import { Component, OnDestroy, OnInit } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';

import { RulesEngineService } from '@mm-services/rules-engine.service';
import { TargetAggregatesService } from '@mm-services/target-aggregates.service';
import { SessionService } from '@mm-services/session.service';
import { UserSettingsService } from '@mm-services/user-settings.service';
import { PerformanceService } from '@mm-services/performance.service';
import { TranslateService } from '@mm-services/translate.service';
import { LanguageService } from '@mm-services/language.service';
import { GlobalActions } from '@mm-actions/global';
import { NgIf, NgFor, NgClass } from '@angular/common';
import { ErrorLogComponent } from '@mm-components/error-log/error-log.component';
import {
  AnalyticsTargetsProgressComponent
} from '@mm-components/analytics-targets-progress/analytics-targets-progress.component';
import { TranslatePipe } from '@ngx-translate/core';
import { ResourceIconPipe } from '@mm-pipes/resource-icon.pipe';
import { TranslateFromPipe } from '@mm-pipes/translate-from.pipe';
import { LocalizeNumberPipe } from '@mm-pipes/number.pipe';
import { Selectors } from '@mm-selectors/index';
import { ReportingPeriod } from './analytics-target-aggregates-sidebar-filter.component';
import { AnalyticsTargetsSidebarFilterComponent } from './analytics-targets-sidebar-filter.component';
import * as moment from 'moment';

@Component({
  templateUrl: './analytics-targets.component.html',
  imports: [
    NgIf,
    ErrorLogComponent,
    NgFor,
    NgClass,
    AnalyticsTargetsProgressComponent,
    TranslatePipe,
    ResourceIconPipe,
    TranslateFromPipe,
    LocalizeNumberPipe,
    AnalyticsTargetsSidebarFilterComponent
  ]
})
export class AnalyticsTargetsComponent implements OnInit, OnDestroy {
  private subscriptions: Subscription = new Subscription();
  private globalActions;
  private uhcMonthStartDate;
  targetsCache = new Map<ReportingPeriod, any[]>();
  private lastFetchTime = new Map<ReportingPeriod, number>();
  
  targets: any[] = [];
  loading = true;
  targetsDisabled = false;
  errorStack;
  trackPerformance;
  direction;
  sidebarFilter;
  selectedPeriod: ReportingPeriod = ReportingPeriod.CURRENT;
  currentMonthDisplay = '';
  previousMonthDisplay = '';
  selectedMonthDisplay = '';
  loadingStates = new Map<ReportingPeriod, boolean>();
  loadingMessage = '';
  showStaleDataWarning = false;
  lastUpdateTime: Map<ReportingPeriod, Date> = new Map();
  emptyStateMessage = '';
  emptyStateIcon = '';
  showEmptyStateAction = false;
  
  isShowingHistoricalData = false;
  noHistoricalDataAvailable = false;

  constructor(
    private rulesEngineService: RulesEngineService,
    private targetAggregatesService: TargetAggregatesService,
    private sessionService: SessionService,
    private userSettingsService: UserSettingsService,
    private performanceService: PerformanceService,
    private store: Store,
    private translateService: TranslateService,
    private languageService: LanguageService,
  ) {
    this.trackPerformance = this.performanceService.track();
    this.globalActions = new GlobalActions(store);
    this.uhcMonthStartDate = 1; // Does this calc already exist somewhere?
    
    const subscription = this.store.select(Selectors.getDirection).subscribe(direction => {
      this.direction = direction;
    });
    this.subscriptions.add(subscription);
  }

  ngOnInit(): void {
    this.initializeMonthDisplays();
    this.globalActions.setSidebarFilter({ isOpen: false });
    this.subscribeToSidebarFilter();
    this.getTargets();
  }
  
  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.targetsCache.clear();
    this.lastFetchTime.clear();
    this.globalActions.clearSidebarFilter();
  }

  private async initializeMonthDisplays() {
    const currentDate = moment();
    const previousDate = moment().subtract(1, 'month');
    const startOfMonth = this.uhcMonthStartDate || 1;
    
    this.currentMonthDisplay = await this.formatMonthDisplay(currentDate, startOfMonth);
    this.previousMonthDisplay = await this.formatMonthDisplay(previousDate, startOfMonth);
    this.updateSelectedMonthDisplay();
  }
  
  private async formatMonthDisplay(date, startDay) {
    const locale = await this.languageService.get() || 'en';
    date.locale(locale);
    
    if (startDay === 1) {
      return date.format('MMMM YYYY');
    }
    const endDate = moment(date).add(1, 'month').date(startDay - 1);
    endDate.locale(locale);
    return `${date.format('MMM D')} - ${endDate.format('MMM D, YYYY')}`;
  }
  
  private updateSelectedMonthDisplay() {
    this.selectedMonthDisplay = this.selectedPeriod === ReportingPeriod.CURRENT 
      ? this.currentMonthDisplay 
      : this.previousMonthDisplay;
  }
  
  private subscribeToSidebarFilter() {
    const filterSubscription = this.store
      .select(Selectors.getSidebarFilter)
      .subscribe(sidebarFilter => {
        this.sidebarFilter = sidebarFilter;
      });
    this.subscriptions.add(filterSubscription);
  }
  
  onReportingPeriodChange(newPeriod) {
    this.handlePeriodChange(newPeriod);
  }
  
  private handlePeriodChange(newPeriod) {
    this.selectedPeriod = newPeriod;
    this.updateSelectedMonthDisplay();
    this.getTargets(newPeriod);
  }
  
  private async getTargets(period?: ReportingPeriod) {
    const targetPeriod = period !== undefined ? period : this.selectedPeriod;
    
    if (period !== undefined) {
      this.selectedPeriod = targetPeriod;
    }
    
    const cached = this.targetsCache.get(targetPeriod);
    if (cached && cached.length > 0) {
      this.targets = cached;
      return;
    }
    
    await this.fetchTargets(targetPeriod);
  }

  async fetchTargets(period: ReportingPeriod, showLoading = true): Promise<void> {
    // Start performance tracking
    const performanceLabel = period === ReportingPeriod.PREVIOUS ? 
      'analytics:targets:historical:load' : 
      'analytics:targets:current:load';
    const stopTimer = this.performanceService.track();
    
    if (showLoading) {
      this.loading = true;
      this.loadingMessage = this.getLoadingMessage(period);
    }
    
    this.loadingStates.set(period, true);
    
    this.isShowingHistoricalData = false;
    this.noHistoricalDataAvailable = false;
    
    try {
      const isEnabled = await this.rulesEngineService.isEnabled();
      this.targetsDisabled = !isEnabled;
      
      if (!isEnabled) {
        this.targets = [];
        this.trackPerformance?.stop({
          name: ['analytics', 'targets', period, 'load'].join(':'),
          recordApdex: true,
        });
        return;
      }
      
      let targets: any[] = [];
      let is_historical = false;
      let document_date: number | undefined;
      
      if (period === ReportingPeriod.CURRENT) {
        targets = await this.rulesEngineService.fetchTargets();
        is_historical = false;
        
      } else if (period === ReportingPeriod.PREVIOUS) {
        const user_settings = await this.userSettingsService.get();
        const user_ctx = this.sessionService.userCtx();
        
        if (!user_settings?.contact_id) {
          console.debug('User has no associated contact, cannot fetch historical targets');
          targets = [];
        } else {
          const options = {
            contact_id: user_settings.contact_id,
            user_id: user_settings._id || `org.couchdb.user:${user_ctx.name}`,
            reporting_period: ReportingPeriod.PREVIOUS
          };
          
          const response = await this.targetAggregatesService.getIndividualTargets(options);
          targets = response.targets;
          is_historical = response.is_historical;
          document_date = response.document_date;
        }
      }
      
      if (period === ReportingPeriod.PREVIOUS) {
        if (!targets || targets.length === 0) {
          this.noHistoricalDataAvailable = true;
          this.handleNoHistoricalData();
        } else {
          this.isShowingHistoricalData = is_historical;
        }
      }
      
      this.targetsCache.set(period, targets);
      this.lastFetchTime.set(period, Date.now());
      this.lastUpdateTime.set(period, new Date());
      this.showStaleDataWarning = false;
      
      if (period === this.selectedPeriod) {
        this.targets = targets.filter(target => target.visible !== false);
        if (!this.targets || this.targets.length === 0) {
          this.handleEmptyTargets(period);
        }
      }
      
      this.trackPerformance?.stop({
        name: ['analytics', 'targets', period, 'load'].join(':'),
        recordApdex: true,
      });
      
    } catch (err) {
      console.error(`Error getting targets for ${period}:`, err);
      this.errorStack = err.stack;
      
      if (this.targetsCache.has(period)) {
        this.showStaleDataWarning = true;
        this.targets = this.targetsCache.get(period) || [];
      } else {
        this.targets = [];
        if (period === ReportingPeriod.PREVIOUS) {
          this.noHistoricalDataAvailable = true;
          this.handleNoHistoricalData();
        }
      }
    } finally {
      this.loading = false;
      this.loadingStates.set(period, false);
      
      stopTimer?.stop({
        name: performanceLabel,
        recordApdex: true
      });
    }
  }

  private getTargetDate(period) {
    if (period === ReportingPeriod.PREVIOUS) {
      return moment().subtract(1, 'month').toDate();
    }
    return new Date();
  }
  
  private getLoadingMessage(period: ReportingPeriod): string {
    if (period === ReportingPeriod.PREVIOUS) {
      return this.translateService?.instant('targets.loading_historical') ||
        'Loading previous month data...';
    }
    
    const monthDisplay = this.currentMonthDisplay;
    return this.translateService?.instant('targets.loading.month', { month: monthDisplay }) ||
      `Loading data for ${monthDisplay}...`;
  }
  
  private handleEmptyTargets(period: ReportingPeriod): void {
    if (period === ReportingPeriod.PREVIOUS && this.noHistoricalDataAvailable) {
      this.handleNoHistoricalData();
      return;
    }
    
    const monthDisplay = period === ReportingPeriod.CURRENT 
      ? this.currentMonthDisplay 
      : this.previousMonthDisplay;
    
    if (period === ReportingPeriod.CURRENT) {
      this.emptyStateMessage = this.translateService?.instant('targets.no_data.current', { month: monthDisplay }) ||
        `No targets available for ${monthDisplay}`;
      this.emptyStateIcon = 'fa-calendar-check-o';
      this.showEmptyStateAction = true;
    } else {
      this.emptyStateMessage = this.translateService?.instant('targets.no_data.previous', { month: monthDisplay }) ||
        `No historical data for ${monthDisplay}`;
      this.emptyStateIcon = 'fa-calendar-times-o';
      this.showEmptyStateAction = false;
    }
  }
  
  private handleNoHistoricalData(): void {
    this.emptyStateIcon = 'fa-history';
    this.emptyStateMessage = this.translateService?.instant('targets.no_historical_data') ||
      'No Previous Month Data Available';
    this.showEmptyStateAction = false;
  }
  
  getLastUpdateDisplay(period: ReportingPeriod): string {
    const lastUpdate = this.lastUpdateTime.get(period);
    if (!lastUpdate) {
      return '';
    }
    
    return moment(lastUpdate).fromNow();
  }
}
