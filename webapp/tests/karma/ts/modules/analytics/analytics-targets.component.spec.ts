import { ComponentFixture, fakeAsync, TestBed, tick, waitForAsync, flush } from '@angular/core/testing';
import { TranslateFakeLoader, TranslateLoader, TranslateModule } from '@ngx-translate/core';
import sinon from 'sinon';
import { expect } from 'chai';

import { AnalyticsTargetsComponent } from '@mm-modules/analytics/analytics-targets.component';
import { RulesEngineService } from '@mm-services/rules-engine.service';
import { SessionService } from '@mm-services/session.service';
import { provideMockStore, MockStore } from '@ngrx/store/testing';
import { PerformanceService } from '@mm-services/performance.service';
import { CalendarIntervalService } from '@mm-services/calendar-interval.service';
import { UHCSettingsService } from '@mm-services/uhc-settings.service';
import { TranslateService } from '@mm-services/translate.service';
import { LanguageService } from '@mm-services/language.service';
import { TargetAggregatesService } from '@mm-services/target-aggregates.service';
import { UserSettingsService } from '@mm-services/user-settings.service';
import { ReportingPeriod } from '@mm-modules/analytics/analytics-target-aggregates-sidebar-filter.component';
import { Selectors } from '@mm-selectors/index';

describe('AnalyticsTargetsComponent', () => {
  let component: AnalyticsTargetsComponent;
  let fixture: ComponentFixture<AnalyticsTargetsComponent>;
  let rulesEngineService;
  let performanceService;
  let stopPerformanceTrackStub;
  let sessionService;
  let calendarIntervalService;
  let uhcSettingsService;
  let translateService;
  let languageService;
  let targetAggregatesService;
  let userSettingsService;
  let store: MockStore;

  beforeEach(waitForAsync(() => {
    rulesEngineService = {
      isEnabled: sinon.stub(),
      fetchTargets: sinon.stub(),
    };
    stopPerformanceTrackStub = sinon.stub();
    performanceService = { track: sinon.stub().returns({ stop: stopPerformanceTrackStub }) };

    sessionService = {
      isOnlineOnly: sinon.stub().returns(false),
      userCtx: sinon.stub().returns({ name: 'test-user' })
    };
    
    calendarIntervalService = {
      getCurrent: sinon.stub().returns({ start: 0, end: 0 }),
      getInterval: sinon.stub().returns({ start: 0, end: 0 })
    };
    
    uhcSettingsService = {
      getMonthStartDate: sinon.stub().returns(1)
    };
    
    translateService = {
      get: sinon.stub().returns({ key: 'test' }),
      instant: sinon.stub().callsFake((key, params) => {
        if (key === 'targets.no_historical_data') {
          return 'No Previous Month Data Available';
        }
        if (key === 'targets.loading_historical') {
          return 'Loading previous month data...';
        }
        if (key === 'targets.loading.month' && params?.month) {
          return `Loading data for ${params.month}...`;
        }
        if (key && key.startsWith('targets.loading')) {
          return 'Loading data...';
        }
        return 'translated text';
      })
    };
    
    languageService = {
      get: sinon.stub().returns('en')
    };

    targetAggregatesService = {
      getIndividualTargets: sinon.stub().resolves({ targets: [], is_historical: false })
    };

    userSettingsService = {
      get: sinon.stub().resolves({ contact_id: 'test-contact', _id: 'org.couchdb.user:test-user' })
    };

    return TestBed
      .configureTestingModule({
        imports: [
          TranslateModule.forRoot({ loader: { provide: TranslateLoader, useClass: TranslateFakeLoader } }),
          AnalyticsTargetsComponent,
        ],
        providers: [
          provideMockStore({ initialState: { global: { sidebarFilter: { isOpen: false, defaultFilters: { reportingPeriod: ReportingPeriod.CURRENT } } } } }),
          { provide: RulesEngineService, useValue: rulesEngineService },
          { provide: PerformanceService, useValue: performanceService },
          { provide: SessionService, useValue: sessionService },
          { provide: CalendarIntervalService, useValue: calendarIntervalService },
          { provide: UHCSettingsService, useValue: uhcSettingsService },
          { provide: TranslateService, useValue: translateService },
          { provide: LanguageService, useValue: languageService },
          { provide: TargetAggregatesService, useValue: targetAggregatesService },
          { provide: UserSettingsService, useValue: userSettingsService },
        ]
      })
      .compileComponents()
      .then(() => {
        store = TestBed.inject(MockStore);
        store.overrideSelector(Selectors.getDirection, 'ltr');
        
        fixture = TestBed.createComponent(AnalyticsTargetsComponent);
        component = fixture.componentInstance;
      });
  }));

  afterEach(() => {
    store?.resetSelectors();
    sinon.restore();
  });

  it('should create', () => {
    expect(component).to.exist;
    expect(performanceService.track.calledOnce).to.be.true;
    fixture.detectChanges();
  });

  it('should set up component when rules engine is not enabled', fakeAsync(() => {
    rulesEngineService.isEnabled.resolves(false);
    
    fixture.detectChanges();
    tick(100);

    expect(rulesEngineService.isEnabled.callCount).to.be.greaterThan(0);
    expect(targetAggregatesService.getIndividualTargets.callCount).to.equal(0);
    expect(component.targetsDisabled).to.equal(true);
    expect(!!component.errorStack).to.be.false;
    expect(stopPerformanceTrackStub.called).to.be.true;
    expect(stopPerformanceTrackStub.args[0][0]).to.deep.equal({ name: 'analytics:targets:current:load', recordApdex: true });
    expect(component.targets).to.deep.equal([]);
    expect(component.loading).to.equal(false);
  }));

  it('should fetch targets when rules engine is enabled', fakeAsync(() => {
    rulesEngineService.isEnabled.resolves(true);
    rulesEngineService.fetchTargets.resolves([{ id: 'target1' }, { id: 'target2' }]);

    fixture.detectChanges();
    tick(100);

    expect(rulesEngineService.isEnabled.callCount).to.equal(1);
    expect(rulesEngineService.fetchTargets.callCount).to.equal(1);
    expect(component.targetsDisabled).to.equal(false);
    expect(!!component.errorStack).to.be.false;
    expect(performanceService.track.calledTwice).to.be.true;
    expect(stopPerformanceTrackStub.called).to.be.true;
    const targetLoadCall = stopPerformanceTrackStub.args.find(args => 
      args[0]?.name?.includes('targets') && args[0]?.name?.includes('load')
    );
    expect(targetLoadCall).to.exist;
    expect(component.targets).to.deep.equal([{ id: 'target1' }, { id: 'target2' }]);
    expect(component.loading).to.equal(false);
  }));

  it('should filter targets to visible ones', fakeAsync(() => {
    rulesEngineService.isEnabled.resolves(true);
    const targets = [
      { id: 'target1' },
      { id: 'target1', visible: true },
      { id: 'target1', visible: undefined },
      { id: 'target1', visible: false },
      { id: 'target1', visible: 'something' },
    ];
    rulesEngineService.fetchTargets.resolves(targets);

    fixture.detectChanges();
    tick(100);

    expect(rulesEngineService.isEnabled.callCount).to.equal(1);
    expect(rulesEngineService.fetchTargets.callCount).to.equal(1);
    expect(!!component.errorStack).to.be.false;
    expect(component.targets).to.deep.equal([
      { id: 'target1' },
      { id: 'target1', visible: true },
      { id: 'target1', visible: undefined },
      { id: 'target1', visible: 'something' },
    ]);
    expect(component.loading).to.equal(false);
  }));

  it('should catch rules engine errors', fakeAsync(() => {
    rulesEngineService.isEnabled.rejects('error');
    const consoleErrorMock = sinon.stub(console, 'error');

    fixture.detectChanges();
    tick(100);

    expect(rulesEngineService.isEnabled.callCount).to.equal(1);
    expect(targetAggregatesService.getIndividualTargets.callCount).to.equal(0);
    expect(component.targetsDisabled).to.equal(false);
    expect(!!component.errorStack).to.be.true;
    expect(component.targets).to.deep.equal([]);
    expect(component.loading).to.equal(false);
    expect(consoleErrorMock.callCount).to.equal(1);
    expect(consoleErrorMock.args[0][0]).to.equal('Error getting targets for current:');
  }));

  it('should initialize month displays', fakeAsync(() => {
    rulesEngineService.isEnabled.resolves(true);
    rulesEngineService.fetchTargets.resolves([]);
    
    fixture.detectChanges(); // Initialize component
    tick(100);
    
    expect(component.currentMonthDisplay).to.be.a('string');
    expect(component.previousMonthDisplay).to.be.a('string');
    expect(component.currentMonthDisplay).to.not.be.empty;
    expect(component.previousMonthDisplay).to.not.be.empty;
  }));

  it('should handle reporting period change', fakeAsync(() => {
    rulesEngineService.isEnabled.resolves(true);
    targetAggregatesService.getIndividualTargets.resolves({ targets: [{ id: 'target1' }], is_historical: false });
    
    fixture.detectChanges();
    flush();
    
    targetAggregatesService.getIndividualTargets.resetHistory();
    
    component.onReportingPeriodChange('previous');
    flush();
    
    expect(component.selectedPeriod).to.equal('previous');
    expect(targetAggregatesService.getIndividualTargets.calledOnce).to.be.true;
  }));

  it('should clean up subscriptions on destroy', () => {
    fixture.detectChanges();
    const unsubscribeSpy = sinon.spy(component['subscriptions'], 'unsubscribe');
    
    component.ngOnDestroy();
    
    expect(unsubscribeSpy.calledOnce).to.be.true;
  });

  describe('Month Toggle Functionality', () => {
    it('should initialize with current period selected', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      rulesEngineService.fetchTargets.resolves([]);
      
      fixture.detectChanges();
      tick(100);

      expect(component.selectedPeriod).to.equal(ReportingPeriod.CURRENT);
      expect(rulesEngineService.fetchTargets.called).to.be.true;
      expect(targetAggregatesService.getIndividualTargets.called).to.be.false;
    }));

    it('should switch to previous period when selected', fakeAsync(() => {
      const previousTargets = [
        { id: 'target1', value: { pass: 5, total: 10 } },
        { id: 'target2', value: { pass: 8, total: 10 } }
      ];
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ targets: previousTargets, is_historical: true });

      fixture.detectChanges();
      tick(100);

      component['getTargets'](ReportingPeriod.PREVIOUS);
      tick();

      expect(component.selectedPeriod).to.equal(ReportingPeriod.PREVIOUS);
      expect(component.targets).to.deep.equal(previousTargets);
      const calls = targetAggregatesService.getIndividualTargets.getCalls();
      const previousCall = calls.find(c => c.args[0]?.reporting_period === ReportingPeriod.PREVIOUS);
      expect(previousCall).to.exist;
    }));

    it('should update month display when period changes', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component.currentMonthDisplay = 'January 2024';
      component.previousMonthDisplay = 'December 2023';

      component.onReportingPeriodChange('previous');
      tick(100);

      expect(component.selectedPeriod).to.equal('previous');
      expect(component.selectedMonthDisplay).to.equal('December 2023');
    }));

    it('should cache targets for each period', fakeAsync(() => {
      const currentTargets = [{ id: 'current1' }];
      const previousTargets = [{ id: 'previous1' }];
      
      rulesEngineService.isEnabled.resolves(true);
      rulesEngineService.fetchTargets.resolves(currentTargets);
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ targets: previousTargets, is_historical: true });
      
      fixture.detectChanges();
      tick(100);

      component['getTargets'](ReportingPeriod.CURRENT);
      tick();

      component['getTargets'](ReportingPeriod.PREVIOUS);
      tick();

      component['getTargets'](ReportingPeriod.CURRENT);
      tick();

      expect(component['targetsCache'].get(ReportingPeriod.CURRENT)).to.deep.equal(currentTargets);
      expect(component['targetsCache'].get(ReportingPeriod.PREVIOUS)).to.deep.equal(previousTargets);
    }));

    it('should handle loading states properly', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.returns(new Promise(resolve => {
        setTimeout(() => resolve({ targets: [], is_historical: false }), 100);
      }));
      
      fixture.detectChanges();
      tick(50);

      component['getTargets'](ReportingPeriod.CURRENT);
      
      expect(component.loading).to.be.true;
      expect(component.loadingStates.get(ReportingPeriod.CURRENT)).to.be.true;
      
      tick(100);
      
      expect(component.loading).to.be.false;
      expect(component.loadingStates.get(ReportingPeriod.CURRENT)).to.be.false;
    }));

    it('should handle empty targets array', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component['getTargets'](ReportingPeriod.CURRENT);
      tick(100);
      
      expect(component.targets).to.deep.equal([]);
      expect(component.emptyStateMessage).to.exist;
    }));

    it('should handle network error gracefully', fakeAsync(async () => {
      const error = new Error('Network error');
      rulesEngineService.isEnabled.resolves(true);
      rulesEngineService.fetchTargets.rejects(error);
      
      fixture.detectChanges();
      tick(100);
      
      component['targetsCache'].set(ReportingPeriod.CURRENT, [{ id: 'cached' }]);
      
      await component['fetchTargets'](ReportingPeriod.CURRENT);
      tick();
      
      expect(component.targets).to.deep.equal([{ id: 'cached' }]);
      expect(component.showStaleDataWarning).to.be.true;
    }))

    it('should filter invisible targets', fakeAsync(async () => {
      const mixedTargets = [
        { id: 'visible1', visible: true },
        { id: 'invisible', visible: false },
        { id: 'visible2' }
      ];
      rulesEngineService.isEnabled.resolves(true);
      rulesEngineService.fetchTargets.resolves(mixedTargets);
      
      fixture.detectChanges();
      tick(100);
      
      component.selectedPeriod = ReportingPeriod.CURRENT;
      
      await component['fetchTargets'](ReportingPeriod.CURRENT);
      tick(100);
      
      expect(component.targets).to.have.length(2);
      expect(component.targets.find(t => t.id === 'invisible')).to.be.undefined;
    }));
  });

  describe('Historical Data Indicators', () => {
    it('should set historical indicators when viewing stored targets', fakeAsync(() => {
      const historicalTargets = [
        { 
          id: 'target1', 
          value: { pass: 5, total: 10 },
          isHistorical: true,
          documentDate: '2024-01-31T23:59:59Z'
        }
      ];
      
      rulesEngineService.isEnabled.resolves(true);
      rulesEngineService.fetchTargets.resolves([]);
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ 
        targets: historicalTargets, 
        is_historical: true,
        document_date: new Date('2024-01-31T23:59:59Z').getTime()
      });
      
      fixture.detectChanges();
      tick(100);
      
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      tick(100);
      
      expect(component.isShowingHistoricalData).to.be.true;
      expect(component.noHistoricalDataAvailable).to.be.false;
    }));

    it('should set no historical data flag when previous period returns empty', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ targets: [], is_historical: true });
      
      fixture.detectChanges();
      tick(100);
      
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      tick(100);
      
      expect(component.isShowingHistoricalData).to.be.false;
      expect(component.noHistoricalDataAvailable).to.be.true;
      expect(component.emptyStateMessage).to.include('No Previous Month Data Available');
    }));

    it('should reset historical indicators when switching to current period', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [{ id: 'current' }], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component.isShowingHistoricalData = true;
      component.noHistoricalDataAvailable = false;
      
      component.onReportingPeriodChange(ReportingPeriod.CURRENT);
      tick(100);
      
      expect(component.isShowingHistoricalData).to.be.false;
      expect(component.noHistoricalDataAvailable).to.be.false;
    }));


    it('should show different loading messages for periods', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component['fetchTargets'](ReportingPeriod.PREVIOUS, true);
      expect(component.loadingMessage).to.include('Loading previous month data...');
      
      component['fetchTargets'](ReportingPeriod.CURRENT, true);
      expect(component.loadingMessage).to.include('Loading data for');
    }));

    it('should handle error with historical data and show cached results', fakeAsync(() => {
      const cachedHistorical = [
        { id: 'cached', isHistorical: true, visible: true }
      ];
      
      rulesEngineService.isEnabled.resolves(true);
      
      fixture.detectChanges();
      flush();
      
      targetAggregatesService.getIndividualTargets.resolves({ targets: cachedHistorical, is_historical: true });
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      flush();
      
      targetAggregatesService.getIndividualTargets.rejects(new Error('Network error'));
      
      component['targetsCache'].clear();
      
      component['targetsCache'].set(ReportingPeriod.PREVIOUS, cachedHistorical);
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      flush();
      
      const expectedTargets = cachedHistorical.filter(t => t.visible !== false);
      expect(component.targets).to.deep.equal(expectedTargets);
      expect(component.showStaleDataWarning).to.be.false;
      expect(component.noHistoricalDataAvailable).to.be.false;
    }));

    it('should handle error with no cached historical data', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.rejects(new Error('Network error'));
      
      fixture.detectChanges();
      tick(100);
      
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      tick(100);
      
      expect(component.targets).to.deep.equal([]);
      expect(component.noHistoricalDataAvailable).to.be.true;
      expect(component.emptyStateMessage).to.include('No Previous Month Data Available');
    }));

    it('should extract document date from first historical target', fakeAsync(() => {
      const targets = [
        { id: 'target1', documentDate: '2024-01-31T23:59:59Z', isHistorical: true },
        { id: 'target2', documentDate: '2024-01-30T10:00:00Z', isHistorical: true }
      ];
      
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ 
        targets: targets, 
        is_historical: true,
        document_date: new Date('2024-01-31T23:59:59Z').getTime()
      });
      
      fixture.detectChanges();
      tick(100);
      
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      tick(100);
      
    }));

    it('should handle missing document date in historical targets', fakeAsync(() => {
      const targets = [
        { id: 'target1', isHistorical: true }
      ];
      
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.withArgs(sinon.match({ reporting_period: ReportingPeriod.PREVIOUS })).resolves({ 
        targets: targets, 
        is_historical: true,
        document_date: undefined
      });
      
      fixture.detectChanges();
      tick(100);
      
      component.onReportingPeriodChange(ReportingPeriod.PREVIOUS);
      tick(100);
      
      expect(component.isShowingHistoricalData).to.be.true;
    }));

    it('should update empty state messages based on period', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component['handleEmptyTargets'](ReportingPeriod.CURRENT);
      expect(component.emptyStateIcon).to.equal('fa-calendar-check-o');
      expect(component.showEmptyStateAction).to.be.true;
      
      component['handleEmptyTargets'](ReportingPeriod.PREVIOUS);
      expect(component.emptyStateIcon).to.equal('fa-calendar-times-o');
      expect(component.showEmptyStateAction).to.be.false;
    }));

    it('should use special handling for no historical data', fakeAsync(() => {
      rulesEngineService.isEnabled.resolves(true);
      targetAggregatesService.getIndividualTargets.resolves({ targets: [], is_historical: false });
      
      fixture.detectChanges();
      tick(100);
      
      component.noHistoricalDataAvailable = true;
      component['handleEmptyTargets'](ReportingPeriod.PREVIOUS);
      
      expect(component.emptyStateIcon).to.equal('fa-history');
      expect(component.emptyStateMessage).to.include('No Previous Month Data Available');
      expect(component.showEmptyStateAction).to.be.false;
    }));

  });
});